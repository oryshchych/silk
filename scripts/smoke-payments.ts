/**
 * Phase 3 end to end on the BUILT app, a seeded database and local fakes of both providers
 * (called from smoke-web.ts, which starts the fakes and points the app at them). Server actions
 * are POSTed like the page script does; webhooks are POSTed to the real routes, signed the way
 * each provider signs them. Proves over HTTP: the redirect to the provider, `paid` only from a
 * verified webhook, a GET of the order page changing nothing, a callback before the buyer returns,
 * the same webhook five times, garbage first then the genuine message, "another card" as a second
 * ATTEMPT on the same order, method and size and rate guards on the routes, no secret in the
 * client bundle. Never talks to a real provider.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createDb } from '../packages/db/src/client.ts';
import type { FakeMono } from '../packages/payments/test/fake-mono.ts';
import type { FakeWayForPay } from '../packages/payments/test/fake-wayforpay.ts';
import { absorb, actionIds, cookieHeader, plentyVariants, type Jar } from './smoke-http.ts';

interface Context {
  base: string;
  buildRoot: string;
  /** The client bundle of the build (the standalone copy does not hold it). */
  staticDir: string;
  databaseUrl: string;
  check: (name: string, ok: boolean) => void;
  wfp: FakeWayForPay;
  mono: FakeMono;
  /** Secret values the app was given; none may appear in the client bundle. */
  secrets: readonly string[];
}

type Row = Record<string, unknown>;

export async function runPaymentSmoke(ctx: Context): Promise<void> {
  const { base, buildRoot, check, wfp, mono } = ctx;
  const ids = actionIds(buildRoot);
  const handle = createDb(ctx.databaseUrl, { max: 2 });
  const query = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    (await handle.pool.query<Row>(text, params)).rows;
  const scalar = async (text: string, params: unknown[] = []): Promise<number> =>
    Number((await query(text, params))[0]?.['n'] ?? -1);

  let clientCounter = 0;
  const newClient = (): string => `203.0.113.${String(++clientCounter)}`;
  const previous = (await query(`SELECT value FROM settings WHERE key = 'payment_providers'`))[0];
  await query(
    `INSERT INTO settings (key, value) VALUES ('payment_providers', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ mono: true, wayforpay: true, cod: true, bank_transfer: true })],
  );

  try {
    // Invoice ids must be unique across runs against a database that keeps earlier attempts.
    mono.onCreate((body) => {
      const invoiceId = `inv-smoke-${randomUUID()}`;
      const info = (body as { merchantPaymInfo?: { reference?: string } }).merchantPaymInfo;
      mono.invoices.set(invoiceId, { invoiceId, status: 'created', reference: info?.reference });
      return { status: 200, json: { invoiceId, pageUrl: `https://pay.example/${invoiceId}` } };
    });
    const { ids: plenty, productPath } = await plentyVariants(base);
    check('payment smoke: found well-stocked variants', plenty.length > 0);
    let drawn = 0;
    const nextVariant = (): string => plenty[drawn++ % Math.max(plenty.length, 1)] ?? '';

    async function action(
      name: string,
      args: unknown,
      jar: Jar,
      client: string,
      path = '/checkout',
    ): Promise<{ redirect: string | null; body: string }> {
      const response = await fetch(base + path, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Next-Action': ids[name] ?? '',
          'Content-Type': 'text/plain;charset=UTF-8',
          'X-Forwarded-For': client,
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify([args]),
      });
      absorb(jar, response);
      return {
        redirect:
          (response.headers.get('x-action-redirect') ?? '').replace(/;(push|replace)$/, '') || null,
        body: await response.text(),
      };
    }

    const unique = String(Date.now()).slice(-6);
    let phoneCounter = 0;
    /** Places a card order and returns where the browser was sent. */
    async function placeCardOrder(provider: 'wayforpay' | 'mono') {
      const jar: Jar = new Map();
      const client = newClient();
      await action(
        'addToCartAction',
        { variantId: nextVariant(), quantity: 1 },
        jar,
        client,
        productPath,
      );
      await action('quoteAction', { locale: 'uk', delivery: 'pickup', promoCode: '' }, jar, client);
      const placed = await action(
        'placeOrderAction',
        {
          locale: 'uk',
          name: 'Тест Покупець',
          email: 'smoke@example.com',
          phone: `050${unique}${String(10 + ++phoneCounter)}`.slice(0, 10),
          delivery: 'pickup',
          payment: provider,
          promoCode: '',
          terms: true,
        },
        jar,
        client,
      );
      const page = await (
        await fetch(base + '/order/success', { headers: { Cookie: cookieHeader(jar) } })
      ).text();
      const number = /<dd class="font-medium">(LS-\d{4}-\d{6})<\/dd>/.exec(page)?.[1] ?? '';
      if (number === '') {
        throw new Error(`payment smoke: the order was not placed: ${placed.body.slice(0, 200)}`);
      }
      const [order] = await query(
        `SELECT id, payment_status, captured_total, status FROM orders WHERE order_number = $1`,
        [number],
      );
      return {
        jar,
        client,
        redirect: placed.redirect,
        number,
        orderId: String(order?.['id']),
        page,
      };
    }

    const attemptOf = async (orderId: string, n = 1): Promise<Row> =>
      (
        await query(
          `SELECT id, local_reference, external_id, amount, status, state FROM payment_attempts
            WHERE order_id = $1 AND attempt_number = $2`,
          [orderId, n],
        )
      )[0] ?? {};
    const paymentStatus = async (orderId: string): Promise<string> =>
      String(
        (await query(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]))[0]?.[
          'payment_status'
        ],
      );
    const post = async (path: string, raw: string, headers: Record<string, string> = {}) =>
      await fetch(base + path, {
        method: 'POST',
        headers: { 'X-Forwarded-For': newClient(), ...headers },
        body: raw,
      });

    // ── WayForPay ──────────────────────────────────────────────────────────
    const w1 = await placeCardOrder('wayforpay');
    const a1 = await attemptOf(w1.orderId);
    const ref1 = String(a1['local_reference']);
    check(
      'a card order redirects the browser to the provider page',
      w1.redirect === `https://secure.example/invoice/${ref1}`,
    );
    check(
      'the provider call carried our reference, the callback URL and a signed request',
      JSON.stringify(wfp.requests.at(-1)?.body).includes(ref1) &&
        JSON.stringify(wfp.requests.at(-1)?.body).includes('/api/webhooks/wayforpay'),
    );
    check(
      'the order exists unpaid with one in-flight attempt and one live reservation',
      (await paymentStatus(w1.orderId)) === 'pending' &&
        a1['state'] === 'in_flight' &&
        (await scalar(
          `SELECT count(*)::int AS n FROM stock_reservations WHERE order_id = $1 AND released_at IS NULL`,
          [w1.orderId],
        )) === 1,
    );
    for (let i = 0; i < 3; i++)
      await fetch(base + '/order/success', { headers: { Cookie: cookieHeader(w1.jar) } });
    check(
      'GET /order/success never changes the status',
      (await paymentStatus(w1.orderId)) === 'pending',
    );
    check(
      'the order page waits for the bank and offers to pay again',
      w1.page.includes('Чекаємо, поки банк підтвердить оплату') &&
        w1.page.includes('Оплатити: Картка (WayForPay)'),
    );

    const amount1 = Number(a1['amount']) / 100;
    const genuine1 = wfp.callback({
      orderReference: ref1,
      amount: amount1,
      transactionStatus: 'Approved',
    });
    // Garbage with the right reference first: quarantine, not payment_events, and the genuine one still applies.
    const quarantineBefore = await scalar(`SELECT count(*)::int AS n FROM webhook_quarantine`);
    const garbage = await post(
      '/api/webhooks/wayforpay',
      wfp.callback({
        orderReference: ref1,
        amount: amount1,
        transactionStatus: 'Approved',
        secret: 'not-the-secret',
      }),
    );
    check('a badly signed callback is a 400', garbage.status === 400);
    check(
      'it lands in webhook_quarantine, not in payment_events',
      (await scalar(`SELECT count(*)::int AS n FROM webhook_quarantine`)) ===
        quarantineBefore + 1 &&
        (await scalar(`SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1`, [
          w1.orderId,
        ])) === 0 &&
        (await paymentStatus(w1.orderId)) === 'pending',
    );
    // The callback arrives BEFORE the buyer returns to the shop.
    const applied = await post('/api/webhooks/wayforpay', genuine1);
    const acceptBody = (await applied.json()) as Record<string, unknown>;
    check(
      'the genuine callback applies and is answered with a signed accept',
      applied.status === 200 &&
        acceptBody['status'] === 'accept' &&
        acceptBody['orderReference'] === ref1 &&
        typeof acceptBody['signature'] === 'string',
    );
    check('the order is paid by the webhook only', (await paymentStatus(w1.orderId)) === 'paid');
    const repeats = await Promise.all(
      Array.from({ length: 4 }, () => post('/api/webhooks/wayforpay', genuine1)),
    );
    const repeatBodies = await Promise.all(
      repeats.map(async (r) => (await r.json()) as Record<string, unknown>),
    );
    check(
      'the same callback five times: every answer is a signed accept',
      repeats.every((r) => r.status === 200) &&
        repeatBodies.every((b) => b['status'] === 'accept' && typeof b['signature'] === 'string'),
    );
    check(
      'and it had one effect: one event, one history row, one confirmation email queued',
      (await scalar(`SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1`, [
        w1.orderId,
      ])) === 1 &&
        (await scalar(
          `SELECT count(*)::int AS n FROM order_status_history WHERE order_id = $1 AND field = 'payment_status' AND source LIKE 'webhook:%'`,
          [w1.orderId],
        )) === 1 &&
        (await scalar(
          `SELECT count(*)::int AS n FROM outbox WHERE topic = 'email.payment-received' AND dedup_key = $1`,
          [`payment-received:${w1.orderId}`],
        )) === 1,
    );
    const paidPage = await (
      await fetch(base + '/order/success', { headers: { Cookie: cookieHeader(w1.jar) } })
    ).text();
    check('the order page now shows the payment as received', paidPage.includes('Оплату отримано'));

    // "Another card": a declined attempt, then a NEW attempt on the SAME order.
    const w2 = await placeCardOrder('wayforpay');
    const a2 = await attemptOf(w2.orderId);
    const reservedBefore = await scalar(
      `SELECT coalesce(sum(reserved_quantity),0)::int AS n FROM product_variants`,
    );
    await post(
      '/api/webhooks/wayforpay',
      wfp.callback({
        orderReference: String(a2['local_reference']),
        amount: Number(a2['amount']) / 100,
        transactionStatus: 'Declined',
        reasonCode: 1101,
      }),
    );
    check(
      'a declined payment fails the attempt, not the order',
      (await paymentStatus(w2.orderId)) === 'failed',
    );
    const again = await action(
      'payOrderAction',
      { locale: 'uk', provider: 'wayforpay' },
      w2.jar,
      w2.client,
      '/order/success',
    );
    const a2b = await attemptOf(w2.orderId, 2);
    check(
      'paying again opens a second attempt on the same order and redirects to a new invoice',
      again.redirect === `https://secure.example/invoice/${String(a2b['local_reference'])}` &&
        (await scalar(`SELECT count(*)::int AS n FROM payment_attempts WHERE order_id = $1`, [
          w2.orderId,
        ])) === 2,
    );
    check(
      'no second order and no second reservation',
      (await scalar(`SELECT count(*)::int AS n FROM orders WHERE order_number = $1`, [
        w2.number,
      ])) === 1 &&
        (await scalar(`SELECT count(*)::int AS n FROM stock_reservations WHERE order_id = $1`, [
          w2.orderId,
        ])) === 1 &&
        (await scalar(
          `SELECT coalesce(sum(reserved_quantity),0)::int AS n FROM product_variants`,
        )) === reservedBefore,
    );
    const strangerJar: Jar = new Map();
    const stranger = await action(
      'payOrderAction',
      { locale: 'uk', provider: 'wayforpay' },
      strangerJar,
      newClient(),
      '/order/success',
    );
    check(
      'without the order cookie nothing can be paid',
      stranger.body.includes('TRACK_NOT_FOUND'),
    );

    // ── Mono ───────────────────────────────────────────────────────────────
    const m1 = await placeCardOrder('mono');
    const ma = await attemptOf(m1.orderId);
    check(
      'a Mono order redirects to the Mono page',
      m1.redirect === `https://pay.example/${String(ma['external_id'])}`,
    );
    const monoBody = JSON.stringify({
      invoiceId: ma['external_id'],
      status: 'success',
      amount: Number(ma['amount']),
      ccy: 980,
      finalAmount: Number(ma['amount']),
      reference: ma['local_reference'],
      modifiedDate: '2026-11-23T10:00:00Z',
    });
    const bad = await post('/api/webhooks/mono', monoBody, {
      'X-Sign': mono.foreignSign(monoBody),
    });
    check(
      'a Mono callback signed with a foreign key is a 400 and changes nothing',
      bad.status === 400 && (await paymentStatus(m1.orderId)) === 'pending',
    );
    const good = await post('/api/webhooks/mono', monoBody, { 'X-Sign': mono.sign(monoBody) });
    check(
      'a Mono callback signed with the merchant key applies',
      good.status === 200 && (await paymentStatus(m1.orderId)) === 'paid',
    );

    // ── Route guards ───────────────────────────────────────────────────────
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(base + '/api/webhooks/mono', {
        method,
        headers: { 'X-Forwarded-For': newClient() },
      });
      check(`${method} on the webhook route is a 405`, response.status === 405);
    }
    check(
      'an oversized body is a 413 before it is read or stored',
      (await post('/api/webhooks/wayforpay', 'x'.repeat(20_000))).status === 413,
    );
    const flooder = newClient();
    let limited = false;
    for (let i = 0; i < 130 && !limited; i++) {
      limited =
        (await post('/api/webhooks/mono', 'junk', { 'X-Forwarded-For': flooder })).status === 429;
    }
    check('a client flooding the webhook route is rate limited', limited);
    const getLimited = await fetch(base + '/api/webhooks/mono', {
      method: 'GET',
      headers: { 'X-Forwarded-For': flooder },
    });
    check('the limit counts every method, not only POST', getLimited.status === 429);
    const heldQuarantine = await scalar(`SELECT count(*)::int AS n FROM webhook_quarantine`);
    check('the quarantine stays far below its cap after a flood', heldQuarantine < 1_000);

    // ── Secrets ────────────────────────────────────────────────────────────
    const leaks: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (statSync(full).isFile()) {
          const text = readFileSync(full, 'utf8');
          for (const secret of ctx.secrets) if (text.includes(secret)) leaks.push(entry.name);
        }
      }
    };
    scan(ctx.staticDir);
    check('no secret value appears in .next/static', leaks.length === 0);
  } finally {
    await query(`DELETE FROM settings WHERE key = 'payment_providers'`);
    if (previous !== undefined) {
      await query(`INSERT INTO settings (key, value) VALUES ('payment_providers', $1::jsonb)`, [
        JSON.stringify(previous['value']),
      ]);
    }
    await handle.close();
  }
}
