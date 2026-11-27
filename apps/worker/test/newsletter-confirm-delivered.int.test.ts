/**
 * `email.newsletter-confirm` through the REAL chain (domain request, relay, pg-boss, router, sender), then the
 * link of the delivered mail really confirms: the whole double opt-in works, and nothing is subscribed before
 * the click. A subscriber who confirmed meanwhile gets no mail.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildConfirmToken,
  confirmSubscription,
  requestSubscription,
  subscribeSchema,
} from '@store/core/marketing';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { bossPublisher, OUTBOX_TOPICS, registerWorkers, startBoss } from '../src/boss.ts';
import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { relayOutbox } from '../src/relay.ts';
import { createMessageSender } from '../src/router.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
let testDb: TestDatabase;
let app: DbHandle;
let boss: PgBoss;

class Recorder implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 4 });
  boss = await startBoss(testDb.bossUrl, { retryLimit: 1, retryDelay: 0, retryBackoff: false });
});
afterEach(async () => {
  await boss.stop({ graceful: false });
  await app.close();
  await testDb.drop();
});

/** pg-boss tables belong to their own role: read them with the boss connection (the app role cannot, so a check through it proves nothing). */
async function jobStates(name: string): Promise<{ state: string; n: number }[]> {
  const client = new pg.Client({ connectionString: testDb.bossUrl });
  await client.connect();
  try {
    const result = await client.query<{ state: string; n: number }>(
      `SELECT state::text AS state, count(*)::int AS n FROM pgboss.job WHERE name = $1 GROUP BY state ORDER BY state`,
      [name],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const startWorker = async (email: Recorder): Promise<void> => {
  await registerWorkers(
    boss,
    createMessageSender({
      reader: app.db,
      email,
      siteUrl: 'https://shop.example',
      authSecret: SECRET,
      fiscal: null,
      log: () => undefined,
    }),
    0.5,
  );
};
const request = async (email: string, locale: 'uk' | 'en' = 'en') =>
  await app.db.transaction(
    async (tx) =>
      await requestSubscription(tx, subscribeSchema.parse({ email, locale, consent: true })),
  );

describe('the newsletter confirmation mail is delivered', () => {
  it('the topic has a queue', () => {
    expect(OUTBOX_TOPICS).toContain('email.newsletter-confirm');
  });

  it('reaches the sender with a link that confirms, and nothing is subscribed before the click', async () => {
    await request('reader@example.test');
    const email = new Recorder();
    await startWorker(email);
    expect(await relayOutbox(app.db, bossPublisher(boss))).toMatchObject({ failed: 0, stuck: 0 });
    await waitFor(() => email.sent.length >= 1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe('reader@example.test');
    expect(email.sent[0]?.subject).toBe('Confirm your Damazla newsletter subscription');
    const before = await app.db.execute<{ c: boolean }>(
      sql`SELECT confirmed_at IS NOT NULL AS c FROM newsletter_subscribers`,
    );
    expect(before.rows[0]?.c).toBe(false);
    const link = /newsletter\/confirm\?t=([^\s]+)/.exec(email.sent[0]?.text ?? '')?.[1] ?? '';
    const result = await app.db.transaction(
      async (tx) => await confirmSubscription(tx, SECRET, decodeURIComponent(link)),
    );
    expect(result).toBe('confirmed');
    expect(await jobStates('outbox.dead')).toEqual([]);
    expect(await jobStates('email.newsletter-confirm')).toEqual([{ state: 'completed', n: 1 }]);
  });

  it('a subscriber who confirmed before the mail was sent gets none', async () => {
    await request('quick@example.test');
    const current = (
      await app.db.execute<{ id: string; nonce: string }>(
        sql`SELECT id, request_nonce::text AS nonce FROM newsletter_subscribers`,
      )
    ).rows[0];
    await app.db.transaction(
      async (tx) =>
        await confirmSubscription(
          tx,
          SECRET,
          buildConfirmToken(SECRET, current?.id ?? '', current?.nonce ?? ''),
        ),
    );
    const email = new Recorder();
    await startWorker(email);
    await relayOutbox(app.db, bossPublisher(boss));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(email.sent).toHaveLength(0);
    // The early return is real: the job COMPLETED (nothing retried, nothing in the dead-letter queue).
    expect(await jobStates('email.newsletter-confirm')).toEqual([{ state: 'completed', n: 1 }]);
    expect(await jobStates('outbox.dead')).toEqual([]);
  });

  it('a subscriber who unsubscribed before the mail was sent gets none, and the job completes', async () => {
    await request('left@example.test');
    await app.db.execute(
      sql`UPDATE newsletter_subscribers SET unsubscribed_at = now(), request_nonce = gen_random_uuid()`,
    );
    const email = new Recorder();
    await startWorker(email);
    await relayOutbox(app.db, bossPublisher(boss));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(email.sent).toHaveLength(0);
    expect(await jobStates('email.newsletter-confirm')).toEqual([{ state: 'completed', n: 1 }]);
    expect(await jobStates('outbox.dead')).toEqual([]);
  });
});
