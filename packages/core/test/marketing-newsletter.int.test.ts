/**
 * The newsletter double opt-in on real Postgres (phase 11, slice C). Consent integrity: a request stores no consent,
 * the link is bound to the request generation (an unsubscribe by link or by the account toggle, a confirmation and a
 * newer request all kill older links), confirming never touches the cart-reminder flag, the same statements run in
 * every state, and the consent evidence (wording version, never the address) is audited only when something happens.
 */
import { createHmac } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { NEWSLETTER_CONSENT_VERSION } from '@store/shared/newsletter';

import { setNewsletter } from '../src/account/profile.ts';
import { deriveKey } from '../src/auth/crypto.ts';
import {
  buildConfirmToken,
  buildMarketingUnsubscribeToken,
  canonicalMailbox,
  confirmSubscription,
  mailboxDomain,
  requestSubscription,
  subscribeSchema,
  unsubscribeMarketingByToken,
} from '../src/marketing/index.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
let world: TestWorld;
let admin: DbHandle;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
});
afterEach(async () => {
  await world.close();
});

const input = (email: string, locale: 'uk' | 'en' = 'uk') =>
  subscribeSchema.parse({ email, locale, consent: true });
const request = async (email: string, handle: DbHandle = admin) =>
  await handle.db.transaction(async (tx) => await requestSubscription(tx, input(email)));
const confirm = async (token: string) =>
  await admin.db.transaction(async (tx) => await confirmSubscription(tx, SECRET, token));
const row = async (email: string) =>
  (
    await admin.db.execute<{
      id: string;
      nonce: string;
      confirmed: boolean;
      unsubscribed: boolean;
      locale: string;
    }>(
      sql`SELECT id, request_nonce::text AS nonce, confirmed_at IS NOT NULL AS confirmed,
                 unsubscribed_at IS NOT NULL AS unsubscribed, locale
            FROM newsletter_subscribers WHERE email = ${email}`,
    )
  ).rows[0];
/** The link the mail would carry right now (the worker mints it from the row at send time). */
const linkFor = async (email: string): Promise<string> => {
  const current = await row(email);
  return buildConfirmToken(SECRET, current?.id ?? '', current?.nonce ?? '');
};
const mails = async (): Promise<number> =>
  (
    await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'email.newsletter-confirm'`,
    )
  ).rows[0]?.n ?? -1;
const audits = async (action: string): Promise<number> =>
  (
    await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`,
    )
  ).rows[0]?.n ?? -1;
const unsubscribeLink = async (email: string): Promise<boolean> =>
  await admin.db.transaction(
    async (tx) =>
      await unsubscribeMarketingByToken(
        tx,
        SECRET,
        buildMarketingUnsubscribeToken(SECRET, (await row(email))?.id ?? ''),
      ),
  );
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

describe('the request', () => {
  it('requires the consent box and a real address; the address is lower-cased', () => {
    expect(
      subscribeSchema.safeParse({ email: 'a@b.co', locale: 'uk', consent: false }).success,
    ).toBe(false);
    expect(subscribeSchema.safeParse({ email: 'a@b.co', locale: 'uk' }).success).toBe(false);
    expect(
      subscribeSchema.safeParse({ email: 'not-an-address', locale: 'uk', consent: true }).success,
    ).toBe(false);
    expect(input('  Mixed@Case.Example ').email).toBe('mixed@case.example');
    expect(canonicalMailbox('Victim+7@Example.Test')).toBe('victim@example.test');
    expect(mailboxDomain('a@Example.Test')).toBe('example.test');
  });

  it('stores NO consent: a pending row, one mail, an audit row with the wording version and no address', async () => {
    expect(await request('new@example.test')).toEqual({ queued: true });
    expect(await row('new@example.test')).toMatchObject({ confirmed: false, unsubscribed: false });
    expect(await mails()).toBe(1);
    const audit = await admin.db.execute<{ action: string; diff: Record<string, unknown> }>(
      sql`SELECT action, diff FROM audit_log WHERE entity = 'newsletter_subscriber'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'marketing.subscription_requested',
      diff: { consentVersion: NEWSLETTER_CONSENT_VERSION, source: 'page', locale: 'uk' },
    });
    expect(JSON.stringify(audit.rows)).not.toContain('example.test');
  });

  it('fifty repeats make one mail and one audit row; another mail only after the hour, same generation', async () => {
    await request('repeat@example.test');
    const generation = (await row('repeat@example.test'))?.nonce;
    for (let i = 0; i < 50; i += 1) await request('repeat@example.test');
    expect(await mails()).toBe(1);
    expect(await audits('marketing.subscription_requested')).toBe(1);
    // The mail in the inbox stays valid: a repeat does not change the generation.
    expect((await row('repeat@example.test'))?.nonce).toBe(generation);
    await admin.db.execute(
      sql`UPDATE newsletter_subscribers SET confirm_mail_queued_at = now() - interval '61 minutes'`,
    );
    expect(await request('repeat@example.test')).toEqual({ queued: true });
    expect(await mails()).toBe(2);
    expect((await row('repeat@example.test'))?.nonce).toBe(generation);
  });

  it('two requests at once make one row and one mail', async () => {
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await request('race@example.test', handle);
    };
    await Promise.all([run(), run()]);
    const rows = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM newsletter_subscribers WHERE email = 'race@example.test'`,
    );
    expect(rows.rows[0]?.n).toBe(1);
    expect(await mails()).toBe(1);
  });

  it('an address that is already subscribed gets no mail, no audit row, and nothing changes', async () => {
    await request('on@example.test');
    expect(await confirm(await linkFor('on@example.test'))).toBe('confirmed');
    await admin.db.execute(sql`DELETE FROM outbox`);
    const before = await row('on@example.test');
    expect(await request('on@example.test')).toEqual({ queued: false });
    expect(await mails()).toBe(0);
    expect(await audits('marketing.subscription_requested')).toBe(1);
    expect(await row('on@example.test')).toEqual(before);
  });

  it('a request that loses a race with the account page waits and then succeeds, never a unique violation', async () => {
    const holder = world.connect();
    const held = gate();
    const inserted = gate();
    const account = holder.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO newsletter_subscribers (email, locale, source, confirmed_at) VALUES ('acct@example.test', 'uk', 'account', now())`,
      );
      inserted.open();
      await held.opened;
    });
    await inserted.opened;
    const pending = request('acct@example.test', world.connect());
    const early = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, 500);
      }),
    ]);
    held.open();
    await account;
    expect(early).toBe(false);
    // The account row is active: the request changes nothing and sends nothing.
    expect(await pending).toEqual({ queued: false });
    expect(await row('acct@example.test')).toMatchObject({ confirmed: true, unsubscribed: false });
  });

  it('a pending row owned by someone else keeps its language when a stranger repeats the request', async () => {
    await request('keep@example.test');
    await admin.db.transaction(
      async (tx) => await requestSubscription(tx, input('keep@example.test', 'en')),
    );
    expect((await row('keep@example.test'))?.locale).toBe('uk');
  });
});

describe('the confirmation link', () => {
  it('confirms once and audits once; a replay is "already"; the account flag is NOT switched on', async () => {
    await admin.db.execute(
      sql`INSERT INTO customers (email, accepts_marketing) VALUES ('acc@example.test', false)`,
    );
    await request('acc@example.test');
    const token = await linkFor('acc@example.test');
    expect(await confirm(token)).toBe('confirmed');
    expect(await confirm(token)).toBe('already');
    expect(await row('acc@example.test')).toMatchObject({ confirmed: true, unsubscribed: false });
    const flag = await admin.db.execute<{ f: boolean }>(
      sql`SELECT accepts_marketing AS f FROM customers WHERE email = 'acc@example.test'`,
    );
    // The newsletter consent covers the newsletter only: the cart reminder flag stays as the customer set it.
    expect(flag.rows[0]?.f).toBe(false);
    expect(await audits('marketing.subscription_confirmed')).toBe(1);
  });

  it('refuses a forged, truncated, expired, other-purpose or re-spelled token and confirms nothing', async () => {
    await request('guard@example.test');
    const current = await row('guard@example.test');
    const id = current?.id ?? '';
    const nonce = current?.nonce ?? '';
    const good = await linkFor('guard@example.test');
    expect(await confirm(`${good}x`)).toBe('invalid');
    expect(await confirm(good.split('.').slice(0, 3).join('.'))).toBe('invalid');
    expect(await confirm('garbage')).toBe('invalid');
    expect(await confirm(buildMarketingUnsubscribeToken(SECRET, id))).toBe('invalid');
    expect(
      await admin.db.transaction(async (tx) => await confirmSubscription(tx, `${SECRET}-x`, good)),
    ).toBe('invalid');
    expect(await confirm(buildConfirmToken(SECRET, id, nonce, Date.now() - 49 * 3600 * 1000))).toBe(
      'expired',
    );
    // Moving the expiry inside a valid token, or writing it with a leading zero, breaks it.
    const [tid, tnonce, , mac] = good.split('.');
    expect(await confirm(`${tid ?? ''}.${tnonce ?? ''}.99999999999.${mac ?? ''}`)).toBe('invalid');
    const [, , expires] = good.split('.');
    expect(await confirm(`${tid ?? ''}.${tnonce ?? ''}.0${expires ?? ''}.${mac ?? ''}`)).toBe(
      'invalid',
    );
    // A token signed with the UNSUBSCRIBE key in the confirm format is not a confirm token (purpose separation).
    const wrongKey = createHmac('sha256', deriveKey(SECRET, 'marketing-unsubscribe'))
      .update(`v2:${id}:${nonce}:${expires ?? ''}`)
      .digest('base64url');
    expect(await confirm(`${id}.${nonce}.${expires ?? ''}.${wrongKey}`)).toBe('invalid');
    expect(await row('guard@example.test')).toMatchObject({ confirmed: false });
  });

  it('a pending row unsubscribed by the link cannot be confirmed by the old link', async () => {
    await request('pu@example.test');
    const old = await linkFor('pu@example.test');
    expect(await unsubscribeLink('pu@example.test')).toBe(true);
    expect(await confirm(old)).toBe('expired');
    expect(await row('pu@example.test')).toMatchObject({ confirmed: false, unsubscribed: true });
  });

  it('a pending row switched off on the account page cannot be confirmed by the old link, and the opt-out stands', async () => {
    const customer = await admin.db.execute<{ id: string }>(
      sql`INSERT INTO customers (email, accepts_marketing) VALUES ('flag@example.test', true) RETURNING id`,
    );
    await request('flag@example.test');
    const old = await linkFor('flag@example.test');
    const changed = await admin.db.transaction(
      async (tx) =>
        await setNewsletter(
          tx,
          { customerId: customer.rows[0]?.id ?? '', userId: customer.rows[0]?.id ?? '', ip: null },
          { subscribe: false },
        ),
    );
    expect(changed).toBe(true);
    expect(await confirm(old)).toBe('expired');
    const flag = await admin.db.execute<{ f: boolean }>(
      sql`SELECT accepts_marketing AS f FROM customers WHERE email = 'flag@example.test'`,
    );
    expect(flag.rows[0]?.f).toBe(false);
    expect(await row('flag@example.test')).toMatchObject({ confirmed: false, unsubscribed: true });
  });

  it('a consumed link stays dead after an unsubscribe and a new request; the new link works, and sends a mail the same hour', async () => {
    await request('again@example.test');
    const first = await linkFor('again@example.test');
    expect(await confirm(first)).toBe('confirmed');
    expect(await unsubscribeLink('again@example.test')).toBe(true);
    await admin.db.execute(sql`DELETE FROM outbox`);
    // Asking again within the hour sends a fresh mail (a new generation), and the page said "sent" truthfully.
    expect(await request('again@example.test')).toEqual({ queued: true });
    expect(await mails()).toBe(1);
    expect(await row('again@example.test')).toMatchObject({
      confirmed: false,
      unsubscribed: false,
    });
    expect(await confirm(first)).toBe('expired');
    expect(await row('again@example.test')).toMatchObject({ confirmed: false });
    expect(await confirm(await linkFor('again@example.test'))).toBe('confirmed');
  });

  it('two clicks at once confirm once', async () => {
    await request('twin@example.test');
    const token = await linkFor('twin@example.test');
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await handle.db.transaction(
        async (tx) => await confirmSubscription(tx, SECRET, token),
      );
    };
    const results = (await Promise.all([run(), run()])).sort();
    expect(results).toEqual(['already', 'confirmed']);
    expect(await audits('marketing.subscription_confirmed')).toBe(1);
  });
});

describe('every consent change rotates the request generation (each layer on its own)', () => {
  const nonceOf = async (email: string) => (await row(email))?.nonce;

  it('a confirmation, an unsubscribe link, the account toggle and a re-open each change the nonce', async () => {
    const customer = await admin.db.execute<{ id: string }>(
      sql`INSERT INTO customers (email, accepts_marketing) VALUES ('rot@example.test', true) RETURNING id`,
    );
    await request('rot@example.test');
    const generation0 = await nonceOf('rot@example.test');
    expect(await confirm(await linkFor('rot@example.test'))).toBe('confirmed');
    const generation1 = await nonceOf('rot@example.test');
    expect(generation1).not.toBe(generation0);
    expect(await unsubscribeLink('rot@example.test')).toBe(true);
    const generation2 = await nonceOf('rot@example.test');
    expect(generation2).not.toBe(generation1);
    await request('rot@example.test');
    const generation3 = await nonceOf('rot@example.test');
    expect(generation3).not.toBe(generation2);
    expect(await confirm(await linkFor('rot@example.test'))).toBe('confirmed');
    const generation4 = await nonceOf('rot@example.test');
    await admin.db.transaction(
      async (tx) =>
        await setNewsletter(
          tx,
          { customerId: customer.rows[0]?.id ?? '', userId: customer.rows[0]?.id ?? '', ip: null },
          { subscribe: false },
        ),
    );
    expect(await nonceOf('rot@example.test')).not.toBe(generation4);
  });

  it('the confirm UPDATE refuses an unsubscribed row even when the nonce was left unchanged', async () => {
    await request('bare@example.test');
    const link = await linkFor('bare@example.test');
    await admin.db.execute(sql`UPDATE newsletter_subscribers SET unsubscribed_at = now()`);
    expect(await confirm(link)).toBe('expired');
    expect(await row('bare@example.test')).toMatchObject({ confirmed: false, unsubscribed: true });
  });
});

describe('the unsubscribe link keeps the cart-reminder flag in step', () => {
  it('switches the account flag off with the subscription', async () => {
    await admin.db.execute(
      sql`INSERT INTO customers (email, accepts_marketing) VALUES ('sync@example.test', true)`,
    );
    await request('sync@example.test');
    expect(await confirm(await linkFor('sync@example.test'))).toBe('confirmed');
    expect(await unsubscribeLink('sync@example.test')).toBe(true);
    const flag = await admin.db.execute<{ f: boolean }>(
      sql`SELECT accepts_marketing AS f FROM customers WHERE email = 'sync@example.test'`,
    );
    expect(flag.rows[0]?.f).toBe(false);
  });
});
