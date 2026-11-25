/**
 * 301 redirects for a changed slug (phase 4 criterion). One pair per locale prefix. The table is
 * kept free of chains and loops: older redirects that pointed at the old path now point at the
 * new one, and a redirect FROM the new path (the slug is being reused) is removed, because that
 * path is live again.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';

import { redirects } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

export type RedirectKind = 'product' | 'category';

const LOCALE_PREFIXES = ['', '/en'] as const;

export const pathOf = (kind: RedirectKind, slug: string, prefix: string): string =>
  `${prefix}/${kind}/${slug}`;

/**
 * A path that is LIVE must not redirect anywhere. EVERY write of a slug (create, rename) calls this
 * for the slug it gives away: an old redirect from a reused slug would otherwise shadow the new
 * page, because the proxy looks redirects up before the page.
 */
export async function releaseSlugPaths(tx: Tx, kind: RedirectKind, slug: string): Promise<void> {
  for (const prefix of LOCALE_PREFIXES) {
    await tx
      .delete(redirects)
      .where(
        and(
          eq(redirects.fromPath, pathOf(kind, slug, prefix)),
          inArray(redirects.statusCode, [301, 302]),
        ),
      );
  }
}

export async function recordSlugRedirects(
  tx: Tx,
  input: { kind: RedirectKind; fromSlug: string; toSlug: string },
): Promise<void> {
  if (input.fromSlug === input.toSlug) return;
  // The new path is live: it must not redirect anywhere.
  await releaseSlugPaths(tx, input.kind, input.toSlug);
  for (const prefix of LOCALE_PREFIXES) {
    const from = pathOf(input.kind, input.fromSlug, prefix);
    const to = pathOf(input.kind, input.toSlug, prefix);
    // Collapse chains: everything that pointed at the old path now points at the new one.
    await tx
      .update(redirects)
      .set({ toPath: to })
      .where(and(eq(redirects.toPath, from), inArray(redirects.statusCode, [301, 302])));
    await tx
      .insert(redirects)
      .values({ fromPath: from, toPath: to, statusCode: 301 })
      .onConflictDoUpdate({
        target: redirects.fromPath,
        set: { toPath: to, statusCode: 301 },
      });
  }
}

export interface RedirectRow {
  fromPath: string;
  toPath: string;
  statusCode: 301 | 302;
}

/** The proxy keeps at most this many redirects in memory; the loader logs when the table reaches it. */
export const REDIRECT_LIMIT = 5_000;

/** The redirects the proxy serves (the table is small; capped so a runaway table cannot fill memory). */
export async function listRedirects(db: Reader): Promise<RedirectRow[]> {
  const rows = await db
    .select({
      fromPath: redirects.fromPath,
      toPath: redirects.toPath,
      statusCode: redirects.statusCode,
    })
    .from(redirects)
    .where(inArray(redirects.statusCode, [301, 302]))
    // Newest first: past the cap the oldest drop out, never an arbitrary subset.
    .orderBy(desc(redirects.createdAt), desc(redirects.id))
    .limit(REDIRECT_LIMIT);
  return rows.flatMap((row) =>
    row.statusCode === 301 || row.statusCode === 302
      ? [{ ...row, statusCode: row.statusCode }]
      : [],
  );
}
