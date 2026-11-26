/**
 * Customers and the exports on real Postgres: sizes derived from purchases, LTV and segments,
 * search at 10 000 orders, tags and note (separate connections), and the two CSV files.
 */
import { sql } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import { AdminNotFoundError } from '../src/catalog-admin/errors.ts';
import { exportCustomersCsv } from '../src/customers-admin/export.ts';
import { getCustomer, listCustomers, emailOfKey } from '../src/customers-admin/read.ts';
import { updateCustomer, updateCustomerSchema } from '../src/customers-admin/update.ts';
import { exportOrdersCsv, ExportRangeError } from '../src/orders-admin/export.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;
let seq = 0;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
});
afterEach(async () => {
  await world.close();
});

async function rows<T extends QueryResultRow>(query: ReturnType<typeof sql>) {
  return (await admin.db.execute<T>(query)).rows;
}
const keyOf = async (email: string): Promise<string> =>
  (
    await rows<{ k: string }>(
      sql`SELECT left(encode(sha256(convert_to(lower(${email}), 'UTF8')), 'hex'), 32) AS k`,
    )
  )[0]?.k ?? '';

/** An order with one item row of the given size, directly (no checkout: this is a read-side test). */
async function order(input: {
  email: string;
  name?: string;
  total?: number;
  status?: string;
  daysAgo?: number;
  sizes?: [string, string, number][];
  refunded?: number;
}): Promise<string> {
  seq += 1;
  const total = input.total ?? 100_000;
  const id =
    (
      await rows<{ id: string }>(sql`
      INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method,
                          subtotal, total, status, payment_status, captured_total, refunded_total, created_at)
      VALUES (${`LS-2026-${String(seq).padStart(6, '0')}`}, ${input.email}, '+380501112233', ${input.name ?? 'Іра Петренко'},
              'pickup', ${total}, ${total}, ${input.status ?? 'delivered'}::order_status, 'paid',
              ${total}, ${input.refunded ?? 0}, now() - make_interval(days => ${input.daysAgo ?? 1}))
      RETURNING id`)
    )[0]?.id ?? '';
  const sizes = input.sizes ?? [['bra', '75B', 1]];
  for (const [system, label, quantity] of sizes) {
    await admin.db.execute(sql`
      INSERT INTO order_items (order_id, product_uid_snapshot, variant_uid_snapshot, name_snapshot, sku_snapshot,
                               size_label, size_system_snapshot, color_name, unit_price, quantity, line_total)
      VALUES (${id}, gen_random_uuid(), gen_random_uuid(), 'Bra', 'SK', ${label}, ${system}, 'Black', 1000, ${quantity}, ${1000 * quantity})`);
  }
  // The order's own CHECKs only need subtotal = total here; items are not summed into it in this fixture.
  return id;
}

describe('the customer card', () => {
  it('derives favourite sizes per system from the purchases, ignoring cancelled and returned orders', async () => {
    await order({
      email: 'Ira@Example.com',
      sizes: [
        ['bra', '75B', 2],
        ['panty', 'M', 1],
      ],
    });
    await order({
      email: 'ira@example.com',
      sizes: [
        ['bra', '75B', 1],
        ['bra', '80B', 2],
        ['panty', 'S', 1],
      ],
    });
    // Bought and cancelled: must not count.
    await order({ email: 'ira@example.com', status: 'cancelled', sizes: [['bra', '80B', 10]] });
    await order({ email: 'ira@example.com', status: 'returned', sizes: [['panty', 'XL', 10]] });
    const customer = await getCustomer(admin.db, await keyOf('ira@example.com'));
    expect(customer?.email).toBe('ira@example.com');
    expect(customer?.sizes.filter((s) => s.system === 'bra')).toEqual([
      { system: 'bra', label: '75B', units: 3 },
      { system: 'bra', label: '80B', units: 2 },
    ]);
    expect(customer?.favouriteSizes).toEqual([
      { system: 'bra', label: '75B' },
      { system: 'panty', label: 'M' },
    ]);
    expect(customer?.orders).toHaveLength(4);
  });

  it('LTV nets refunds and skips cancelled, returned and pending orders; orders count skips cancelled', async () => {
    const email = 'ltv@example.com';
    await order({ email, total: 100_000, refunded: 30_000 });
    await order({ email, total: 50_000 });
    await order({ email, total: 99_999, status: 'cancelled' });
    await order({ email, total: 77_777, status: 'returned' });
    await order({ email, total: 11_111, status: 'pending' });
    const customer = await getCustomer(admin.db, await keyOf(email));
    expect(customer).toMatchObject({ ltv: 120_000, ordersCount: 4, segment: 'repeat' });
    // Average over the counted orders: 120 000 / 4.
    expect(customer?.averageOrder).toBe(30_000);
  });

  it('segments: new, repeat, vip and lapsed', async () => {
    await order({ email: 'new@example.com' });
    await order({ email: 'repeat@example.com' });
    await order({ email: 'repeat@example.com' });
    await order({ email: 'vip@example.com', total: 1_000_000 });
    await order({ email: 'old@example.com', daysAgo: 200 });
    const segment = async (email: string) =>
      (await getCustomer(admin.db, await keyOf(email)))?.segment;
    expect(await segment('new@example.com')).toBe('new');
    expect(await segment('repeat@example.com')).toBe('repeat');
    expect(await segment('vip@example.com')).toBe('vip');
    expect(await segment('old@example.com')).toBe('lapsed');
    const vips = await listCustomers(admin.db, { segment: 'vip' });
    expect(vips.items.map((c) => c.email)).toEqual(['vip@example.com']);
  });

  it('an unknown or malformed key is null, and the page never carries the email in a key', async () => {
    expect(await getCustomer(admin.db, 'f'.repeat(32))).toBeNull();
    expect(await getCustomer(admin.db, "'; DROP TABLE orders; --")).toBeNull();
    expect(await emailOfKey(admin.db, 'nope')).toBeNull();
    await order({ email: 'k@example.com' });
    const [row] = (await listCustomers(admin.db, {})).items;
    expect(row?.key).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.key).not.toContain('example');
  });
});

describe('the list at scale and under hostile input', () => {
  it('opens a page of 10 000 orders from 4 000 customers in under 500 ms, with search and filters', async () => {
    await admin.db.execute(sql`
      INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method,
                          subtotal, total, status, payment_status, created_at)
      SELECT 'LS-2026-' || lpad(i::text, 6, '0'), 'buyer' || (i % 4000) || '@example.com',
             '+3805011' || lpad((i % 4000)::text, 5, '0'), 'Buyer ' || (i % 4000), 'pickup', 129900, 129900,
             'delivered', 'paid', now() - (i || ' minutes')::interval
        FROM generate_series(1, 10000) AS i`);
    const timed = async (filters: Parameters<typeof listCustomers>[1]) => {
      const started = performance.now();
      const page = await listCustomers(admin.db, filters);
      return { page, ms: performance.now() - started };
    };
    const plain = await timed({});
    expect(plain.page.total).toBe(4000);
    expect(plain.page.items).toHaveLength(50);
    expect(plain.ms).toBeLessThan(500);
    for (const filters of [
      { q: 'buyer77@' },
      { q: '0501100077' },
      { q: 'Buyer 12' },
      { segment: 'repeat' as const },
      { page: 80 },
    ]) {
      expect((await timed(filters)).ms, JSON.stringify(filters)).toBeLessThan(500);
    }
  });

  it('treats %, _, a backslash and a NUL byte as text, and ignores a NaN page', async () => {
    await order({ email: 'a_b@example.com' });
    for (const q of ['%', '_', '\\', 'a\u0000b', "'; DROP TABLE orders; --"]) {
      expect((await listCustomers(admin.db, { q })).items, q).toEqual([]);
    }
    expect((await listCustomers(admin.db, { q: 'a_b@' })).items).toHaveLength(1);
    expect((await listCustomers(admin.db, { page: Number.NaN })).page).toBe(1);
  });
});

describe('tags and note', () => {
  it('creates the customer row on the first write, normalises tags, and a repeat is a no-op', async () => {
    await order({ email: 'Tag@Example.com' });
    const key = await keyOf('tag@example.com');
    const input = updateCustomerSchema.parse({
      key,
      tags: ['VIP', ' vip ', 'Wholesale', 'тест'],
      note: ' call before delivery ',
    });
    expect(input.tags).toEqual(['wholesale', 'vip', 'тест'].sort());
    const first = await admin.db.transaction(async (tx) => await updateCustomer(tx, input));
    expect(first).toMatchObject({ changed: true, noteChanged: true, tagsFrom: [] });
    const again = await admin.db.transaction(async (tx) => await updateCustomer(tx, input));
    expect(again.changed).toBe(false);
    expect(
      await rows(sql`SELECT 1 FROM customers WHERE lower(email) = 'tag@example.com'`),
    ).toHaveLength(1);
    const card = await getCustomer(admin.db, key);
    expect(card?.tags).toEqual(input.tags);
    expect(card?.note).toBe('call before delivery');
    const byTag = await listCustomers(admin.db, { tag: 'wholesale' });
    expect(byTag.items.map((c) => c.email)).toEqual(['tag@example.com']);
    expect((await listCustomers(admin.db, { tag: 'nobody' })).items).toEqual([]);
  });

  it('refuses bad tags and notes at the schema, and an unknown customer in the domain', async () => {
    const key = 'a'.repeat(32);
    for (const tags of [
      ['a b'],
      ['x'.repeat(31)],
      [''],
      ['semi;colon'],
      Array.from({ length: 11 }, (_, i) => `t${String(i)}`),
    ]) {
      expect(
        updateCustomerSchema.safeParse({ key, tags, note: '' }).success,
        JSON.stringify(tags),
      ).toBe(false);
    }
    expect(updateCustomerSchema.safeParse({ key, tags: [], note: 'x'.repeat(1001) }).success).toBe(
      false,
    );
    expect(updateCustomerSchema.safeParse({ key, tags: [], note: 'a\u0000b' }).success).toBe(false);
    expect(updateCustomerSchema.safeParse({ key: 'nope', tags: [], note: '' }).success).toBe(false);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await updateCustomer(tx, updateCustomerSchema.parse({ key, tags: [], note: '' })),
      ),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });

  it('two people tagging one new customer at once: one row, the last write wins, no unique violation', async () => {
    await order({ email: 'race@example.com' });
    const key = await keyOf('race@example.com');
    const barrier = new Barrier(2);
    const run = async (tags: string[]) => {
      const handle = world.connect();
      return await handle.db.transaction(async (tx) => {
        await barrier.wait();
        return await updateCustomer(tx, updateCustomerSchema.parse({ key, tags, note: '' }));
      });
    };
    await Promise.all([run(['one']), run(['two'])]);
    expect(
      await rows(sql`SELECT 1 FROM customers WHERE lower(email) = 'race@example.com'`),
    ).toHaveLength(1);
  });
});

describe('review round 1 (#75): numbers, phones and truncation', () => {
  const day = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const dataLines = (csv: string) =>
    csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
      .slice(1);

  it('a negative adjustment stays a number, a text cell that starts with a minus is still neutralised', async () => {
    const id = await order({ email: 'neg@example.com', total: 100_000, daysAgo: 0 });
    await admin.db.execute(
      sql`UPDATE orders SET adjustment_total = -500, total = subtotal - discount_total + shipping_total - 500, fiscal_receipt_id = '-cmd', refunded_total = 0 WHERE id = ${id}`,
    );
    const file = await exportOrdersCsv(admin.db, { from: day(), to: day() });
    const cells = dataLines(file.csv)[0]?.split(',') ?? [];
    expect(cells).toContain('-5.00');
    expect(cells).toContain("'-cmd");
    expect(file.csv).not.toContain("'-5.00");
  });

  it('a phone in the customers file has no apostrophe', async () => {
    await order({ email: 'phone@example.com' });
    const file = await exportCustomersCsv(admin.db, {});
    expect(file.csv).toContain(',+380501112233,');
    expect(file.csv).not.toContain("'+380");
  });

  it('a cut orders file ends with the sentinel line, and the next part continues after it with no gap or repeat', async () => {
    for (let i = 0; i < 5; i += 1)
      await order({ email: `cut${String(i)}@example.com`, daysAgo: 0 });
    const range = { from: day(), to: day(), limit: 2 };
    const first = await exportOrdersCsv(admin.db, range);
    expect(first).toMatchObject({ rows: 2, truncated: true });
    const lines = dataLines(first.csv);
    expect(lines.at(-1)).toBe(`# truncated: next part starts after ${first.lastNumber ?? ''}`);
    const second = await exportOrdersCsv(admin.db, { ...range, after: first.lastNumber ?? '' });
    const third = await exportOrdersCsv(admin.db, { ...range, after: second.lastNumber ?? '' });
    expect(third).toMatchObject({ rows: 1, truncated: false });
    expect(dataLines(third.csv).some((line) => line.startsWith('# truncated'))).toBe(false);
    const numbers = [first, second, third].flatMap((f) =>
      dataLines(f.csv)
        .filter((l) => !l.startsWith('#'))
        .map((l) => l.split(',')[0]),
    );
    expect(numbers).toHaveLength(5);
    expect(new Set(numbers).size).toBe(5);
  });

  it('a cut customers file says so too, and a file that fits has no sentinel', async () => {
    for (let i = 0; i < 3; i += 1) await order({ email: `c${String(i)}@example.com` });
    const cut = await exportCustomersCsv(admin.db, { limit: 2 });
    expect(cut.truncated).toBe(true);
    expect(dataLines(cut.csv).at(-1)).toContain(
      '# truncated: next part starts after c1@example.com',
    );
    const rest = await exportCustomersCsv(admin.db, { after: cut.lastEmail ?? '', limit: 2 });
    expect(rest.truncated).toBe(false);
    expect(rest.csv).not.toContain('# truncated');
  });

  it('the tag filter is case-insensitive like the stored tags', async () => {
    await order({ email: 'tagcase@example.com' });
    await admin.db.transaction(
      async (tx) =>
        await updateCustomer(
          tx,
          updateCustomerSchema.parse({
            key: await keyOf('tagcase@example.com'),
            tags: ['VIP'],
            note: '',
          }),
        ),
    );
    expect((await listCustomers(admin.db, { tag: 'Vip' })).items).toHaveLength(1);
    expect((await listCustomers(admin.db, { tag: ' VIP ' })).items).toHaveLength(1);
  });
});

describe('the exports', () => {
  it('the orders CSV: two decimals, no email or phone, Kyiv days, a cursor, formulas neutralised', async () => {
    await order({
      email: 'acc@example.com',
      total: 129_950,
      refunded: 10_000,
      daysAgo: 0,
      name: '=HYPERLINK("x")',
    });
    await admin.db.execute(
      sql`UPDATE orders SET ttn = '59000000000001', fiscal_receipt_id = '=cmd'`,
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
    const file = await exportOrdersCsv(admin.db, { from: today, to: today });
    expect(file.rows).toBe(1);
    expect(file.csv).toContain('1299.50');
    expect(file.csv).toContain('100.00');
    expect(file.csv).toContain("'=cmd");
    expect(file.csv).not.toContain('acc@example.com');
    expect(file.csv).not.toContain('+380');
    expect(file.csv).not.toContain('HYPERLINK');
    const after = await exportOrdersCsv(admin.db, {
      from: today,
      to: today,
      after: file.lastNumber ?? '',
    });
    expect(after.rows).toBe(0);
  });

  it('refuses a range that is not two real days in order', async () => {
    for (const [from, to] of [
      ['2026-13-01', '2026-13-02'],
      ['2026-02-30', '2026-03-01'],
      ['2026-05-02', '2026-05-01'],
      ['x', 'y'],
    ]) {
      await expect(
        exportOrdersCsv(admin.db, { from: from ?? '', to: to ?? '' }),
      ).rejects.toBeInstanceOf(ExportRangeError);
    }
  });

  it('the customers CSV carries personal data, with LTV in hryvnias and neutralised cells', async () => {
    await order({ email: 'csv@example.com', name: '@evil', total: 250_050 });
    const file = await exportCustomersCsv(admin.db, {});
    expect(file).toMatchObject({ rows: 1, truncated: false, lastEmail: 'csv@example.com' });
    expect(file.csv).toContain('csv@example.com');
    expect(file.csv).toContain('2500.50');
    expect(file.csv).toContain("'@evil");
    expect((await exportCustomersCsv(admin.db, { after: 'csv@example.com' })).rows).toBe(0);
  });
});
