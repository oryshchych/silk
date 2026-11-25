import type { AdminOutcome } from '@store/core/admin-outcome';
import type { AdminSession } from '@store/core/auth';
import type { Permission } from '@store/core/auth-permissions';
import type { Tx } from '@store/db/types';
import type { z } from 'zod';

import { knownProductSlugs } from '../product-slugs';
import { redirectMap } from '../redirect-map';
import { adminAction } from './bound-action';
import { invalidateTags } from './invalidate';

/** What a committed change must drop besides the storefront tags. */
export interface Dropped {
  /** The proxy's table of 301s (a slug changed hands). */
  redirects?: boolean;
  /** The proxy's set of visible product slugs (a product appeared, vanished or was renamed). */
  slugs?: boolean;
}

/**
 * A catalog mutation: the domain function runs in `adminAction`'s transaction (role, Origin,
 * validation, limit already checked), its audit entry is written in the same transaction, and
 * only AFTER the commit are the storefront tags invalidated. A failed or refused action
 * invalidates nothing. A call that changed nothing writes no audit row and drops no cache.
 */
export async function catalogAction<S extends z.ZodType, T>(spec: {
  permission: Permission;
  schema: S;
  input: unknown;
  op: (tx: Tx, input: z.infer<S>, session: AdminSession) => Promise<AdminOutcome<T>>;
  /** What the committed change drops besides the tags, decided from its result. */
  dropped?: (data: T) => Dropped;
}) {
  let tags: string[] = [];
  const result = await adminAction({
    permission: spec.permission,
    schema: spec.schema,
    input: spec.input,
    run: async ({ tx, input, session, audit, skipAudit }) => {
      const outcome = await spec.op(tx, input, session);
      if (outcome.audit.action === 'update' && Object.keys(outcome.audit.diff).length === 0) {
        skipAudit();
      } else {
        await audit(outcome.audit);
      }
      for (const extra of outcome.extraAudits ?? []) await audit(extra);
      tags = outcome.tags;
      return outcome.data;
    },
  });
  if (result.ok) {
    // The change is committed: a failure to refresh a cache must not turn it into an error.
    try {
      invalidateTags(tags);
      const dropped = spec.dropped?.(result.data) ?? {};
      if (dropped.redirects === true) redirectMap.invalidate();
      if (dropped.slugs === true) knownProductSlugs.invalidate();
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'cache-invalidation', reason: error instanceof Error ? error.name : 'unknown' })}\n`,
      );
    }
  }
  return result;
}
