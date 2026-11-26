/**
 * `email.waybill-created` through the real message router on Postgres: the buyer gets the waybill
 * number and the tracking link once, the number is read from the database (never the payload), and
 * a missing number or a malformed payload is not a silent success.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setCartItem, startCheckout } from '@store/core/cart';
import { createOrder } from '@store/core/orders';
import { createDb, type DbHandle } from '@store/db/client';
import { settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { renderWaybillCreated } from '../src/email/waybill-email.ts';
import { createMessageSender } from '../src/router.ts';

let testDb: TestDatabase;
let app: DbHandle;
let orderId: string;

class Recorder implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 3 });
  const fixture = await app.db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: 'payment_providers', value: { cod: true, mono: true } });
    return await seedMoneySkeleton(tx);
  });
  const token = 'tok-waybill-email-x'.padEnd(20, 'x');
  await app.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId: fixture.variantIds[0], quantity: 1 });
  });
  const intent = await app.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await app.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: intent.intentId,
        ownerToken: token,
        contact: {
          email: 'buyer@example.com',
          phone: '+380501234567',
          name: 'Іра <b>Петренко</b>',
        },
        delivery: { method: 'pickup' },
        paymentProvider: 'cod',
        promoCode: null,
        locale: 'en',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  orderId = placed.orderId;
});
afterEach(async () => {
  await app.close();
  await testDb.drop();
});

const senderFor = (email: Recorder) =>
  createMessageSender({
    reader: app.db,
    email,
    siteUrl: 'https://shop.example',
    fiscal: null,
    log: () => undefined,
  });
const message = (payload: unknown) => ({
  idempotencyKey: `waybill:${orderId}`,
  topic: 'email.waybill-created',
  payload,
});

describe('email.waybill-created', () => {
  it('mails the number and the tracking link once, in the order locale, with the name escaped', async () => {
    await app.db.execute(sql`UPDATE orders SET ttn = '59000000000042' WHERE id = ${orderId}`);
    const email = new Recorder();
    await senderFor(email).send(message({ orderId }));
    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0];
    expect(sent?.to).toBe('buyer@example.com');
    expect(sent?.subject).toContain('has been shipped');
    expect(sent?.text).toContain('59000000000042');
    expect(sent?.text).toContain('https://novaposhta.ua/tracking/?cargo_number=59000000000042');
    expect(sent?.html).not.toContain('<b>Петренко</b>');
    expect(sent?.idempotencyKey).toBe(`waybill:${orderId}:customer`);
  });

  it('sends nothing when the order has no number now, and refuses a malformed payload', async () => {
    const email = new Recorder();
    await senderFor(email).send(message({ orderId }));
    expect(email.sent).toHaveLength(0);
    await expect(senderFor(email).send(message({ orderId: 'nope' }))).rejects.toThrow();
    await expect(senderFor(email).send(message({}))).rejects.toThrow();
  });

  it('the number comes from the database: a payload that carries another one changes nothing', async () => {
    await app.db.execute(sql`UPDATE orders SET ttn = '59000000000042' WHERE id = ${orderId}`);
    const email = new Recorder();
    await senderFor(email).send(message({ orderId, ttn: '59000000009999' }));
    expect(email.sent[0]?.text).not.toContain('9999');
  });

  it('renders Ukrainian copy too', () => {
    const rendered = renderWaybillCreated({
      orderNumber: 'LS-2026-000001',
      locale: 'uk',
      customerName: 'Іра',
      ttn: '59000000000042',
    });
    expect(rendered.subject).toContain('відправлено');
    expect(rendered.text).toContain('59000000000042');
  });
});
