/** Failure notices and quarantine retention on real Postgres (phase 3). */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { WayForPayProvider } from '@store/payments/wayforpay';
import {
  FAKE_ACCOUNT,
  FAKE_SECRET,
  startFakeWayForPay,
  type FakeWayForPay,
} from '@store/payments/test/fake-wayforpay';

import { cancelOrder } from '../src/orders/fulfilment.ts';
import { createPaymentAttempt, recordAttemptResult } from '../src/payments/attempts.ts';
import { handlePaymentWebhook } from '../src/payments/handle-webhook.ts';
import { purgeQuarantine } from '../src/payments/quarantine.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { placeOrder } from './place-order.ts';

let fake: FakeWayForPay;
let wfp: WayForPayProvider;
let world: TestWorld;
let admin: DbHandle;

beforeAll(async () => {
  fake = await startFakeWayForPay();
  wfp = new WayForPayProvider({
    baseUrl: fake.baseUrl,
    merchantAccount: FAKE_ACCOUNT,
    secretKey: FAKE_SECRET,
    merchantDomainName: 'shop.example',
  });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
});
afterEach(async () => {
  await world.close();
});

const count = async (query: ReturnType<typeof sql>): Promise<number> =>
  (await admin.db.execute<{ n: number }>(query)).rows[0]?.n ?? -1;

async function declinedOrder(): Promise<{ orderId: string; deliver: () => Promise<void> }> {
  const orderId = await placeOrder(admin, world.fixture.variantIds[0], 'wayforpay');
  const attempt = await admin.db.transaction(
    async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'wayforpay' }),
  );
  await admin.db.transaction(async (tx) => {
    await recordAttemptResult(tx, {
      attemptId: attempt.attemptId,
      result: {
        ok: true,
        redirectUrl: 'https://secure.example/x',
        externalId: attempt.localReference,
      },
    });
  });
  const raw = fake.callback({
    orderReference: attempt.localReference,
    amount: Number(attempt.amount) / 100,
    transactionStatus: 'Declined',
    reasonCode: 1101,
  });
  return {
    orderId,
    deliver: async () => {
      await handlePaymentWebhook(
        {
          provider: wfp,
          runInTransaction: async (fn) => await admin.db.transaction(async (tx) => await fn(tx)),
        },
        { rawBody: Buffer.from(raw), headers: new Headers(), sourceIp: null },
      );
    },
  };
}

describe('a failed payment', () => {
  it('queues ONE notice for the buyer, however often the callback is redelivered', async () => {
    const { deliver } = await declinedOrder();
    await deliver();
    await deliver();
    await deliver();
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'email.payment-failed'`),
    ).toBe(1);
  });

  it('queues none for a cancelled order: it can no longer be paid', async () => {
    const { orderId, deliver } = await declinedOrder();
    await admin.db.transaction(
      async (tx) => await cancelOrder(tx, { orderId, source: 'test', reason: null }),
    );
    await deliver();
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'email.payment-failed'`),
    ).toBe(0);
  });
});

describe('quarantine retention', () => {
  it('removes only what is older than the retention', async () => {
    await admin.db.execute(
      sql`INSERT INTO webhook_quarantine (provider, raw_body, reason, created_at)
          VALUES ('mono', 'a', 'x', now() - interval '15 days'),
                 ('mono', 'b', 'x', now() - interval '13 days'),
                 ('mono', 'c', 'x', now())`,
    );
    expect(await admin.db.transaction(async (tx) => await purgeQuarantine(tx))).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM webhook_quarantine`)).toBe(2);
    expect(await admin.db.transaction(async (tx) => await purgeQuarantine(tx, 0))).toBe(2);
  });
});
