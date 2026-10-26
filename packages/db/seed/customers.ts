/** Клієнти. Адреси @example.com: листи на них нікуди не дійдуть навіть без EMAIL_TO_OVERRIDE. */
import { customers } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';

export interface SeedCustomer {
  id: string;
  email: string;
  phone: string;
  name: string;
}

const PEOPLE = [
  ['Олена', 'Коваленко', 'uk'],
  ['Ірина', 'Шевчук', 'uk'],
  ['Марія', 'Бондаренко', 'uk'],
  ['Наталія', 'Ткаченко', 'uk'],
  ['Юлія', 'Мельник', 'uk'],
  ['Анна', 'Кравченко', 'en'],
  ['Катерина', 'Олійник', 'uk'],
  ['Софія', 'Гнатюк', 'uk'],
] as const;

export async function seedCustomers(tx: Tx): Promise<SeedCustomer[]> {
  const rows = PEOPLE.map(([first, last, locale], i) => ({
    email: `customer${String(i + 1)}@example.com`,
    phone: `+38067${String(1000000 + i * 1111).padStart(7, '0')}`,
    firstName: first,
    lastName: last,
    locale,
    acceptsMarketing: i % 2 === 0,
  }));
  const inserted = await tx
    .insert(customers)
    .values(rows)
    .returning({ id: customers.id, email: customers.email });
  return inserted.map((row, i) => {
    const source = rows[i];
    if (source === undefined) throw new Error('клієнт без специфікації');
    return {
      id: row.id,
      email: row.email,
      phone: source.phone,
      name: `${source.firstName} ${source.lastName}`,
    };
  });
}
