/**
 * Company and contact data for the About and Contacts pages. Everything comes from the `settings` table
 * (`company`: legalName, taxId, registeredAddress; `contacts`: phone, email, telegram, viber, address), filled
 * in by the owner (owner queue Q77). Nothing is invented: an unset, blank or malformed value is `null`, and
 * the page shows an explicit "not set" marker for it. A value is plain text (rendered escaped) and bounded.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import { companyProfileDto, type CompanyProfileDto } from '@store/shared/dto/legal';
import { serialize } from '@store/shared/dto/serialize';

const text = z
  .string()
  .transform((value) => value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').trim())
  .pipe(z.string().max(300))
  .transform((value) => (value === '' ? null : value));

const orNull = (value: unknown): string | null => {
  const parsed = text.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const field = (source: unknown, key: string): unknown =>
  typeof source === 'object' && source !== null
    ? Object.entries(source).find(([name]) => name === key)?.[1]
    : undefined;

export async function getCompanyProfile(reader: Reader): Promise<CompanyProfileDto> {
  const result = await reader.execute<{ key: string; value: unknown }>(
    sql`SELECT key, value FROM settings WHERE key IN ('company', 'contacts')`,
  );
  const byKey = new Map(result.rows.map((row) => [row.key, row.value]));
  const company = byKey.get('company');
  const contacts = byKey.get('contacts');
  return serialize(companyProfileDto, {
    legalName: orNull(field(company, 'legalName')),
    taxId: orNull(field(company, 'taxId')),
    registeredAddress: orNull(field(company, 'registeredAddress')),
    phone: orNull(field(contacts, 'phone')),
    email: orNull(field(contacts, 'email')),
    telegram: orNull(field(contacts, 'telegram')),
    viber: orNull(field(contacts, 'viber')),
    address: orNull(field(contacts, 'address')),
  });
}
