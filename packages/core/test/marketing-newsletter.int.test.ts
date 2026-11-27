/**
 * The newsletter double opt-in on real Postgres (phase 11, slice C): a request stores no consent, the answer
 * does not depend on who is subscribed, only a click on the mailed link confirms, an old link cannot
 * re-subscribe someone who left, and the consent evidence (wording version, never the address) is audited.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { NEWSLETTER_CONSENT_VERSION } from '@store/shared/newsletter';

import {
  buildConfirmToken,
  buildMarketingUnsubscribeToken,
  confirmSubscription,
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
      confirmed: boolean;
      unsubscribed: boolean;
      locale: string;
    }>(
      sql`SELECT id, confirmed_at IS NOT NULL AS confirmed, unsubscribed_at IS NOT NULL AS unsubscribed, locale
            FROM newsletter_subscribers WHERE email = ${email}`,
    )
  ).rows[0];
const mails = async (): Promise<number> =>
  (
    await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'email.newsletter-confirm'`,
    )
  ).rows[0]?.n ?? -1;

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

  it('asking again within the hour sends no second mail; two requests at once make one row and one mail', async () => {
    await request('twice@example.test');
    await request('twice@example.test');
    expect(await mails()).toBe(1);
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
    expect(await mails()).toBe(2);
  });

  it('an address that is already subscribed gets no mail and nothing changes', async () => {
    await request('on@example.test');
    const id = (await row('on@example.test'))?.id ?? '';
    expect(await confirm(buildConfirmToken(SECRET, id))).toBe('confirmed');
    await admin.db.execute(sql`DELETE FROM outbox`);
    expect(await request('on@example.test')).toEqual({ queued: false });
    expect(await mails()).toBe(0);
    expect(await row('on@example.test')).toMatchObject({ confirmed: true, unsubscribed: false });
  });
});

describe('the confirmation link', () => {
  it('confirms once, mirrors the account flag, audits once; a replay is "already"', async () => {
    await admin.db.execute(
      sql`INSERT INTO customers (email, accepts_marketing) VALUES ('acc@example.test', false)`,
    );
    await request('acc@example.test');
    const id = (await row('acc@example.test'))?.id ?? '';
    const token = buildConfirmToken(SECRET, id);
    expect(await confirm(token)).toBe('confirmed');
    expect(await confirm(token)).toBe('already');
    expect(await row('acc@example.test')).toMatchObject({ confirmed: true, unsubscribed: false });
    const flag = await admin.db.execute<{ f: boolean }>(
      sql`SELECT accepts_marketing AS f FROM customers WHERE email = 'acc@example.test'`,
    );
    expect(flag.rows[0]?.f).toBe(true);
    const audits = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'marketing.subscription_confirmed'`,
    );
    expect(audits.rows[0]?.n).toBe(1);
  });

  it('refuses a forged, truncated, expired or other-purpose token and confirms nothing', async () => {
    await request('guard@example.test');
    const id = (await row('guard@example.test'))?.id ?? '';
    const good = buildConfirmToken(SECRET, id);
    expect(await confirm(`${good}x`)).toBe('invalid');
    expect(await confirm(good.split('.').slice(0, 2).join('.'))).toBe('invalid');
    expect(await confirm('garbage')).toBe('invalid');
    expect(await confirm(buildMarketingUnsubscribeToken(SECRET, id))).toBe('invalid');
    expect(
      await admin.db.transaction(async (tx) => await confirmSubscription(tx, `${SECRET}-x`, good)),
    ).toBe('invalid');
    const old = buildConfirmToken(SECRET, id, Date.now() - 49 * 3600 * 1000);
    expect(await confirm(old)).toBe('expired');
    // Moving the expiry inside a valid token breaks the signature.
    const [tid, , mac] = good.split('.');
    expect(await confirm(`${tid ?? ''}.99999999999.${mac ?? ''}`)).toBe('invalid');
    expect(await row('guard@example.test')).toMatchObject({ confirmed: false });
  });

  it('an old link cannot re-subscribe someone who unsubscribed since; asking again makes a new pending request', async () => {
    await request('leave@example.test');
    const id = (await row('leave@example.test'))?.id ?? '';
    const link = buildConfirmToken(SECRET, id);
    expect(await confirm(link)).toBe('confirmed');
    await admin.db.transaction(
      async (tx) =>
        await unsubscribeMarketingByToken(tx, SECRET, buildMarketingUnsubscribeToken(SECRET, id)),
    );
    expect(await row('leave@example.test')).toMatchObject({ confirmed: true, unsubscribed: true });
    // The mailed link from before is replayed: nothing happens.
    expect(await confirm(link)).toBe('already');
    expect(await row('leave@example.test')).toMatchObject({ confirmed: true, unsubscribed: true });
    // Asking again re-opens the request as pending (consent must be given anew) and a new link works.
    await admin.db.execute(sql`DELETE FROM outbox`);
    expect(await request('leave@example.test')).toEqual({ queued: true });
    expect(await row('leave@example.test')).toMatchObject({ confirmed: false, unsubscribed: true });
    expect(await confirm(buildConfirmToken(SECRET, id))).toBe('confirmed');
    expect(await row('leave@example.test')).toMatchObject({ confirmed: true, unsubscribed: false });
  });
});
