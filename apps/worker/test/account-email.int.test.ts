/**
 * `email.account-verify` / `email.password-reset` through the real router on Postgres: the link is
 * rebuilt from the token id (the queue never holds it), a used or expired link is not mailed, a
 * missing secret fails the job, and the mail goes to the address on file in the account's language.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requestRegistration } from '@store/core/customer-auth';
import { createDb, type DbHandle } from '@store/db/client';
import { authEmailTokens, outbox } from '@store/db/schema';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { createMessageSender } from '../src/router.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
let testDb: TestDatabase;
let app: DbHandle;

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
});
afterEach(async () => {
  await app.close();
  await testDb.drop();
});

const senderFor = (email: Recorder, ...secret: [] | [string | undefined]) =>
  createMessageSender({
    reader: app.db,
    email,
    siteUrl: 'https://shop.example/',
    authSecret: secret.length === 0 ? SECRET : secret[0],
    fiscal: null,
    log: () => undefined,
  });

async function queued(address: string, locale: 'uk' | 'en') {
  await app.db.transaction(async (tx) => {
    await requestRegistration(tx, {
      email: address,
      locale,
      client: { ip: null, userAgent: null },
    });
  });
  const [row] = await app.db.select().from(outbox).where(eq(outbox.topic, 'email.account-verify'));
  if (row === undefined) throw new Error('nothing queued');
  return { topic: row.topic, idempotencyKey: row.dedupKey ?? 'k', payload: row.payload };
}

describe('account link mail', () => {
  it('mails the link built from the id, to the address on file, in the stored language', async () => {
    const message = await queued('Anna@Example.test', 'en');
    const email = new Recorder();
    await senderFor(email).send(message);
    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0];
    expect(sent?.to).toBe('anna@example.test');
    expect(sent?.text).toMatch(/^To finish signing up/);
    expect(sent?.text).toMatch(
      /https:\/\/shop\.example\/en\/account\/set-password\?t=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/,
    );
    expect(JSON.stringify(message.payload)).not.toMatch(/@|\./);
  });

  it('Ukrainian link has no locale prefix', async () => {
    const email = new Recorder();
    await senderFor(email).send(await queued('uk@example.test', 'uk'));
    expect(email.sent[0]?.text).toContain('https://shop.example/account/set-password?t=');
  });

  it('sends nothing for a link that was used, replaced or has expired', async () => {
    const message = await queued('used@example.test', 'uk');
    await app.db.execute(sql`UPDATE auth_email_tokens SET used_at = now()`);
    const email = new Recorder();
    await senderFor(email).send(message);
    expect(email.sent).toHaveLength(0);
    await app.db.execute(
      sql`UPDATE auth_email_tokens SET used_at = NULL, created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'`,
    );
    await senderFor(email).send(message);
    expect(email.sent).toHaveLength(0);
    expect(await app.db.select().from(authEmailTokens)).toHaveLength(1);
  });

  it('fails the job (dead-letter, visible) without a strong secret, and for a malformed payload', async () => {
    const message = await queued('nosecret@example.test', 'uk');
    const email = new Recorder();
    await expect(senderFor(email, undefined).send(message)).rejects.toThrow();
    await expect(senderFor(email, 'short').send(message)).rejects.toThrow();
    await expect(
      senderFor(email).send({ ...message, payload: { tokenId: 'x' } }),
    ).rejects.toThrow();
    await expect(
      senderFor(email).send({
        ...message,
        payload: { tokenId: '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12), email: 'a@b.c' },
      }),
    ).rejects.toThrow();
    expect(email.sent).toHaveLength(0);
  });
});
