import type { AdminOutcome } from '@store/core/admin-outcome';
import type { Permission } from '@store/core/auth-permissions';
import type { Tx } from '@store/db/types';
import type { z } from 'zod';

import { redirectMap } from '../redirect-map';
import { adminAction } from './bound-action';
import { invalidateTags } from './invalidate';

/**
 * A catalog mutation: the domain function runs in `adminAction`'s transaction (role, Origin,
 * validation, limit already checked), its audit entry is written in the same transaction, and
 * only AFTER the commit are the storefront tags invalidated. A failed or refused action
 * invalidates nothing.
 */
export async function catalogAction<S extends z.ZodType, T>(spec: {
  permission: Permission;
  schema: S;
  input: unknown;
  /** True when the change can add a redirect: the proxy's table is dropped after the commit. */
  touchesRedirects?: boolean;
  op: (tx: Tx, input: z.infer<S>) => Promise<AdminOutcome<T>>;
}) {
  let tags: string[] = [];
  const result = await adminAction({
    permission: spec.permission,
    schema: spec.schema,
    input: spec.input,
    run: async ({ tx, input, audit }) => {
      const outcome = await spec.op(tx, input);
      await audit(outcome.audit);
      tags = outcome.tags;
      return outcome.data;
    },
  });
  if (result.ok) {
    invalidateTags(tags);
    if (spec.touchesRedirects === true) redirectMap.invalidate();
  }
  return result;
}
