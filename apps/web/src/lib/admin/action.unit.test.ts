import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { DomainError } from '@store/core/errors';
import type { Tx } from '@store/db/types';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createRateLimiter } from '../rate-limit';
import { createAdminAction, MissingAuditError, type AdminActionDeps } from './action';

vi.mock('@store/core/audit', () => ({
  writeAudit: vi.fn(() => Promise.resolve()),
}));

const session = (role: AdminSession['role']): ResolvedSession => ({
  kind: 'full',
  session: { sid: 's', userId: `user-${role}`, email: `${role}@example.test`, role },
});

function setup(overrides: Partial<AdminActionDeps> = {}) {
  // The wrapper only hands the transaction to the handler; a stand-in is enough (writeAudit is mocked).
  const fakeTx = {} as unknown as Tx;
  const transaction = vi.fn();
  async function runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    transaction();
    return await fn(fakeTx);
  }
  const deps: AdminActionDeps = {
    originOk: () => Promise.resolve(true),
    session: () => Promise.resolve(session('content')),
    transaction: runInTransaction,
    client: () => Promise.resolve('203.0.113.9'),
    limiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    ...overrides,
  };
  return { action: createAdminAction(deps), transaction };
}

const schema = z.object({ price: z.number().int().positive() });

describe('adminAction: the checks run inside the action, in order', () => {
  it('a role without the permission is refused and the handler never runs (content cannot set a price)', async () => {
    const { action, transaction } = setup();
    const run = vi.fn();
    const result = await action({
      permission: 'catalog.price',
      schema,
      input: { price: 100 },
      run,
    });
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(run).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('is refused before the input is parsed: a forbidden caller learns nothing about the schema', async () => {
    const { action } = setup();
    const result = await action({
      permission: 'catalog.price',
      schema,
      input: 'garbage',
      run: vi.fn(),
    });
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
  });

  it('no session, or only a pending one, is UNAUTHENTICATED', async () => {
    const run = vi.fn();
    const none = setup({ session: () => Promise.resolve(null) });
    expect(await none.action({ permission: 'admin.view', schema, input: {}, run })).toEqual({
      ok: false,
      code: 'UNAUTHENTICATED',
    });
    const pending = setup({
      session: () =>
        Promise.resolve({
          kind: 'pending' as const,
          next: 'totp' as const,
          session: { sid: 's', userId: 'u', email: 'o@example.test', role: 'owner' as const },
        }),
    });
    expect(await pending.action({ permission: 'admin.view', schema, input: {}, run })).toEqual({
      ok: false,
      code: 'UNAUTHENTICATED',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('a foreign or missing Origin is refused before the session is even read', async () => {
    const readSession = vi.fn(() => Promise.resolve(session('owner')));
    const { action } = setup({ originOk: () => Promise.resolve(false), session: readSession });
    expect(await action({ permission: 'admin.view', schema, input: {}, run: vi.fn() })).toEqual({
      ok: false,
      code: 'BAD_ORIGIN',
    });
    expect(readSession).not.toHaveBeenCalled();
  });

  it('rejects invalid input for an allowed role', async () => {
    const { action } = setup({ session: () => Promise.resolve(session('admin')) });
    const run = vi.fn();
    expect(
      await action({ permission: 'catalog.price', schema, input: { price: -5 }, run }),
    ).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('limits each user separately', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    let current: ResolvedSession = session('admin');
    const { action } = setup({ limiter, session: () => Promise.resolve(current) });
    const call = async () =>
      await action({
        permission: 'catalog.price',
        schema,
        input: { price: 1 },
        run: async ({ audit }) => {
          await audit({ action: 'update', entity: 'product' });
        },
      });
    expect((await call()).ok).toBe(true);
    expect((await call()).ok).toBe(true);
    expect(await call()).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    current = session('owner');
    expect((await call()).ok).toBe(true);
  });

  it('an allowed role runs the handler with the verified session and a writing audit', async () => {
    const { action } = setup({ session: () => Promise.resolve(session('admin')) });
    const result = await action({
      permission: 'catalog.price',
      schema,
      input: { price: 12900 },
      run: async ({ input, session: who, audit }) => {
        await audit({
          action: 'update',
          entity: 'product',
          entityId: 'p1',
          diff: { price: input.price },
        });
        return who.role;
      },
    });
    expect(result).toEqual({ ok: true, data: 'admin' });
    const { writeAudit } = await import('@store/core/audit');
    expect(writeAudit).toHaveBeenLastCalledWith(expect.anything(), {
      action: 'update',
      entity: 'product',
      entityId: 'p1',
      diff: { price: 12900 },
      userId: 'user-admin',
      ip: '203.0.113.9',
    });
  });

  it('a handler that writes no audit row is rolled back and reported', async () => {
    const { action } = setup({ session: () => Promise.resolve(session('admin')) });
    await expect(
      action({
        permission: 'catalog.price',
        schema,
        input: { price: 1 },
        run: () => Promise.resolve('done'),
      }),
    ).rejects.toBeInstanceOf(MissingAuditError);
  });

  it('a domain error becomes a failure code; any other error propagates', async () => {
    const { action } = setup({ session: () => Promise.resolve(session('admin')) });
    expect(
      await action({
        permission: 'catalog.price',
        schema,
        input: { price: 1 },
        run: () => Promise.reject(new DomainError('SOME_CODE', 'nope')),
      }),
    ).toEqual({ ok: false, code: 'SOME_CODE' });
    await expect(
      action({
        permission: 'catalog.price',
        schema,
        input: { price: 1 },
        run: () => Promise.reject(new Error('boom')),
      }),
    ).rejects.toThrow('boom');
  });
});
