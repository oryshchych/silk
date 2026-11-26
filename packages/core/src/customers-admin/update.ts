/**
 * Tags and the internal note of a customer. The customer row (`customers`) is created on the first
 * write, keyed by the lower-cased email of the orders: a buyer nobody tagged has no row. Tags are a
 * short allowlist of characters, at most ten; the note is bounded free text that never enters the
 * audit row (it lives on the customer, with the author in the audit entry).
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { customers } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { AdminNotFoundError } from '../catalog-admin/errors.ts';
import { emailOfKey } from './read.ts';

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes('\u0000'), 'no NUL byte');

export const customerTag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[\p{L}\p{N}_-]{1,30}$/u);

export const updateCustomerSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{32}$/),
  tags: z
    .array(customerTag)
    .max(10)
    .transform((tags) => [...new Set(tags)].sort()),
  note: text(1000).transform((value) => (value === '' ? null : value)),
});
export type UpdateCustomerInput = z.output<typeof updateCustomerSchema>;

export async function updateCustomer(
  tx: Tx,
  input: UpdateCustomerInput,
): Promise<{ changed: boolean; tagsFrom: string[]; tagsTo: string[]; noteChanged: boolean }> {
  const email = await emailOfKey(tx, input.key);
  if (email === null) throw new AdminNotFoundError('customer');
  // One writer per customer: the row is created or locked by the upsert below, so two edits queue.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${email}`}))`);
  const [existing] = await tx
    .select({ tags: customers.tags, note: customers.adminNote })
    .from(customers)
    .where(sql`lower(${customers.email}) = ${email}`);
  const tagsFrom = [...(existing?.tags ?? [])].sort();
  const noteFrom = existing?.note ?? null;
  const same =
    existing !== undefined &&
    tagsFrom.join('\u0000') === input.tags.join('\u0000') &&
    noteFrom === input.note;
  if (same) return { changed: false, tagsFrom, tagsTo: input.tags, noteChanged: false };
  if (existing === undefined) {
    await tx.insert(customers).values({ email, tags: input.tags, adminNote: input.note });
  } else {
    await tx
      .update(customers)
      .set({ tags: input.tags, adminNote: input.note })
      .where(eq(sql`lower(${customers.email})`, email));
  }
  return {
    changed: true,
    tagsFrom,
    tagsTo: input.tags,
    noteChanged: noteFrom !== input.note,
  };
}
