/**
 * 301 redirects for a changed slug (phase 4 criterion). One pair per locale prefix. The table is
 * kept free of chains and loops: older redirects that pointed at the old path now point at the
 * new one, and a redirect FROM the new path (the slug is being reused) is removed, because that
 * path is live again.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { redirects } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

export type RedirectKind = 'product' | 'category';

const LOCALE_PREFIXES = ['', '/en'] as const;

export const pathOf = (kind: RedirectKind, slug: string, prefix: string): string =>
  `${prefix}/${kind}/${slug}`;

export async function recordSlugRedirects(
  tx: Tx,
  input: { kind: RedirectKind; fromSlug: string; toSlug: string },
): Promise<void> {
  if (input.fromSlug === input.toSlug) return;
  for (const prefix of LOCALE_PREFIXES) {
    const from = pathOf(input.kind, input.fromSlug, prefix);
    const to = pathOf(input.kind, input.toSlug, prefix);
    // The new path is live again: it must not redirect anywhere.
    await tx
      .delete(redirects)
      .where(and(eq(redirects.fromPath, to), inArray(redirects.statusCode, [301, 302])));
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

const REDIRECT_LIMIT = 5_000;

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
    .limit(REDIRECT_LIMIT);
  return rows.flatMap((row) =>
    row.statusCode === 301 || row.statusCode === 302
      ? [{ ...row, statusCode: row.statusCode }]
      : [],
  );
}
