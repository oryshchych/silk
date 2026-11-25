import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const invalidate = vi.fn();
const dropRedirects = vi.fn();
const dropSlugs = vi.fn();
const auditCalls: unknown[] = [];
const skipped = vi.fn();
let commitFails = false;
let invalidateThrows = false;

vi.mock('./invalidate', () => ({
  invalidateTags: (tags: string[]) => {
    if (invalidateThrows) throw new Error('revalidate failed');
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
vi.mock('../product-slugs', () => ({
  knownProductSlugs: {
    invalidate: () => {
      dropSlugs();
    },
  },
}));
vi.mock('./bound-action', () => ({
  // A stand-in for adminAction: runs the handler like the real one, or refuses like it. With
  // `commitFails` the handler has run, then the commit (or the audit write) fails.
  adminAction: async (spec: {
    permission: string;
    input: unknown;
    run: (context: {
      tx: unknown;
      input: unknown;
      session: unknown;
      audit: (entry: unknown) => Promise<void>;
      skipAudit: () => void;
    }) => Promise<unknown>;
  }) => {
    if (spec.permission === 'refused') return { ok: false, code: 'FORBIDDEN' };
    const data = await spec.run({
      tx: {},
      input: spec.input,
      session: { role: 'admin' },
      audit: (entry) => {
        auditCalls.push(entry);
        return Promise.resolve();
      },
      skipAudit: skipped,
    });
    if (commitFails) return { ok: false, code: 'COMMIT_FAILED' };
    return { ok: true, data };
  },
}));

const { catalogAction } = await import('./catalog-action');

const outcome = {
  data: { changed: ['nameUk'] },
  audit: {
    action: 'update' as const,
    entity: 'product',
    entityId: 'p1',
    diff: { nameUk: { from: 'a', to: 'b' } },
  },
  tags: ['product:p1', 'listing:c1'],
};
const base = { permission: 'catalog.edit' as const, schema: z.object({}), input: {} };

describe('catalogAction', () => {
  it('writes the audit entry and invalidates the tags only AFTER a successful action', async () => {
    invalidate.mockClear();
    const result = await catalogAction({ ...base, op: () => Promise.resolve(outcome) });
    expect(result).toEqual({ ok: true, data: outcome.data });
    expect(auditCalls.at(-1)).toEqual(outcome.audit);
    expect(invalidate).toHaveBeenCalledWith(['product:p1', 'listing:c1']);
    expect(dropRedirects).not.toHaveBeenCalled();
    expect(dropSlugs).not.toHaveBeenCalled();
  });

  it('drops the redirect table and the slug set only when the result says a slug changed', async () => {
    dropRedirects.mockClear();
    dropSlugs.mockClear();
    const dropped = (data: { changed: string[] }) =>
      data.changed.includes('slug') ? { redirects: true, slugs: true } : {};
    await catalogAction({ ...base, dropped, op: () => Promise.resolve(outcome) });
    expect(dropRedirects).not.toHaveBeenCalled();
    await catalogAction({
      ...base,
      dropped,
      op: () => Promise.resolve({ ...outcome, data: { changed: ['slug'] } }),
    });
    expect(dropRedirects).toHaveBeenCalledTimes(1);
    expect(dropSlugs).toHaveBeenCalledTimes(1);
  });

  it('a call that changed nothing writes no audit row (it is skipped, not faked)', async () => {
    auditCalls.length = 0;
    skipped.mockClear();
    await catalogAction({
      ...base,
      op: () => Promise.resolve({ ...outcome, audit: { ...outcome.audit, diff: {} }, tags: [] }),
    });
    expect(auditCalls).toHaveLength(0);
    expect(skipped).toHaveBeenCalledTimes(1);
  });

  it('a refused action invalidates nothing and never runs the domain function', async () => {
    invalidate.mockClear();
    dropRedirects.mockClear();
    const op = vi.fn();
    const refused = await catalogAction({ ...base, permission: 'refused' as never, op });
    expect(refused).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(op).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(dropRedirects).not.toHaveBeenCalled();
  });

  it('an action whose handler ran but whose commit or audit failed invalidates NOTHING', async () => {
    invalidate.mockClear();
    dropRedirects.mockClear();
    dropSlugs.mockClear();
    commitFails = true;
    const result = await catalogAction({
      ...base,
      dropped: () => ({ redirects: true, slugs: true }),
      op: () => Promise.resolve(outcome),
    });
    commitFails = false;
    expect(result).toEqual({ ok: false, code: 'COMMIT_FAILED' });
    expect(invalidate).not.toHaveBeenCalled();
    expect(dropRedirects).not.toHaveBeenCalled();
    expect(dropSlugs).not.toHaveBeenCalled();
  });

  it('a cache refresh that throws after the commit does not turn the committed change into an error', async () => {
    invalidateThrows = true;
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await catalogAction({ ...base, op: () => Promise.resolve(outcome) });
    invalidateThrows = false;
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
    expect(result).toEqual({ ok: true, data: outcome.data });
  });
});
