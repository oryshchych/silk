/**
 * Withdrawing marketing consent from a link, without a session: the signed subscriber id IS the credential.
 * `newsletter_subscribers` is the source of truth; the flag on the matching customer mirrors it. A repeat
 * changes nothing and writes no second audit row. The audit row names the subscriber id, never the address.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '@store/db/types';

import { writeAudit } from '../audit/write-audit.ts';
import { readMarketingUnsubscribeToken } from './unsubscribe-token.ts';

/** True for a valid token (even when already unsubscribed), false for a forged or malformed one. */
export async function unsubscribeMarketingByToken(
  tx: Tx,
  secret: string | undefined,
  token: string,
): Promise<boolean> {
  const id = readMarketingUnsubscribeToken(secret, token);
  if (id === null) return false;
  const changed = await tx.execute<{ email: string }>(
    sql`UPDATE newsletter_subscribers SET unsubscribed_at = now()
         WHERE id = ${id}::uuid AND unsubscribed_at IS NULL RETURNING email`,
  );
  const email = changed.rows[0]?.email;
  if (email === undefined) return true;
  await tx.execute(
    sql`UPDATE customers SET accepts_marketing = false WHERE email = ${email} AND accepts_marketing`,
  );
  await writeAudit(tx, {
    userId: null,
    action: 'marketing.unsubscribed_by_link',
    entity: 'newsletter_subscriber',
    entityId: id,
  });
  return true;
}
