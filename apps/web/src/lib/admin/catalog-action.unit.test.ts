import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const invalidate = vi.fn();
const dropRedirects = vi.fn();
const auditCalls: unknown[] = [];

vi.mock('./invalidate', () => ({
  invalidateTags: (tags: string[]) => {
    invalidate(tags);
  },
}));
vi.mock('../redirect-map', () => ({
  redirectMap: {
    invalidate: () => {
      dropRedirects();
    },
  },
}));
vi.mock('./bound-action', () => ({
  // A stand-in for adminAction: runs the handler like the real one, or refuses like it.
  adminAction: async (spec: {
    permission: string;
    input: unknown;
    run: (context: {
      tx: unknown;
      input: unknown;
      audit: (entry: unknown) => Promise<void>;
    }) => Promise<unknown>;
  }) => {
    if (spec.permission === 'refused') return { ok: false, code: 'FORBIDDEN' };
    const data = await spec.run({
      tx: {},
      input: spec.input,
      audit: (entry) => {
        auditCalls.push(entry);
        return Promise.resolve();
      },
    });
    return { ok: true, data };
  },
}));

const { catalogAction } = await import('./catalog-action');

const outcome = {
  data: { changed: ['nameUk'] },
  audit: { action: 'update' as const, entity: 'product', entityId: 'p1', diff: {} },
  tags: ['product:p1', 'listing:c1'],
};

describe('catalogAction', () => {
  it('writes the audit entry and invalidates the tags only AFTER a successful action', async () => {
    invalidate.mockClear();
    const result = await catalogAction({
      permission: 'catalog.edit',
      schema: z.object({}),
      input: {},
      op: () => Promise.resolve(outcome),
    });
    expect(result).toEqual({ ok: true, data: outcome.data });
    expect(auditCalls.at(-1)).toEqual(outcome.audit);
    expect(invalidate).toHaveBeenCalledWith(['product:p1', 'listing:c1']);
    expect(dropRedirects).not.toHaveBeenCalled();
  });

  it('drops the redirect table of the proxy when the change can add a redirect', async () => {
    dropRedirects.mockClear();
    await catalogAction({
      permission: 'catalog.edit',
      schema: z.object({}),
      input: {},
      touchesRedirects: true,
      op: () => Promise.resolve(outcome),
    });
    expect(dropRedirects).toHaveBeenCalledTimes(1);
  });

  it('a refused action invalidates nothing and never runs the domain function', async () => {
    invalidate.mockClear();
    dropRedirects.mockClear();
    const op = vi.fn();
    const refused = await catalogAction({
      permission: 'refused' as never,
      schema: z.object({}),
      input: {},
      touchesRedirects: true,
      op,
    });
    expect(refused).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(op).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(dropRedirects).not.toHaveBeenCalled();
  });
});
