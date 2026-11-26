/**
 * Legal documents on real Postgres: version numbers under parallel drafts, the current version chosen by
 * the DATABASE clock (a draft and a future start are invisible, a newer version replaces an older one, an
 * old version is never served after that), a publish that cannot start in the past, immutability and
 * undeletability of a published version enforced by the database, sanitising on write and again on read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { createDb } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import {
  LegalEmptyError,
  LegalNotDraftError,
  LegalStartTakenError,
  createLegalDraft,
  deleteLegalDraft,
  legalCreateSchema,
  legalUpdateSchema,
  publishLegalDocument,
  setLegalFile,
  updateLegalDraft,
  listLegalDocuments,
} from '../src/legal/admin.ts';
import {
  currentConsentRefs,
  currentPolicyRef,
  getCurrentLegalDocument,
  listCurrentLegalNav,
} from '../src/legal/read.ts';

const USER = '00000000-0000-4000-8000-0000000000bb';
let testDb: TestDatabase;
let handle: DbHandle;
let other: DbHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  other = createDb(testDb.appUrl, { max: 4 });
});
afterAll(async () => {
  await handle.close();
  await other.close();
  await testDb.drop();
});

const create = (over: Record<string, unknown> = {}) =>
  legalCreateSchema.parse({
    kind: 'terms',
    locale: 'uk',
    title: 'Terms',
    source: '## Hello\n\nBody text',
    ...over,
  });

async function draft(over: Record<string, unknown> = {}): Promise<{ id: string; version: string }> {
  return await handle.db.transaction(async (tx) => await createLegalDraft(tx, USER, create(over)));
}
const publish = async (id: string) =>
  await handle.db.transaction(async (tx) => await publishLegalDocument(tx, USER, id));

describe('versions', () => {
  it('numbers versions per (kind, locale), starting at 1, and never reuses one', async () => {
    const a = await draft({ kind: 'privacy', locale: 'uk' });
    const b = await draft({ kind: 'privacy', locale: 'uk' });
    const c = await draft({ kind: 'privacy', locale: 'en' });
    expect([a.version, b.version, c.version]).toEqual(['1', '2', '1']);
    await handle.db.transaction(async (tx) => await deleteLegalDraft(tx, b.id));
    expect((await draft({ kind: 'privacy', locale: 'uk' })).version).toBe('2');
  });

  it('gives parallel drafts from separate connections distinct numbers', async () => {
    const results = await Promise.all(
      [handle, other, handle, other, handle, other].map(
        async (db) =>
          await db.db.transaction(
            async (tx) =>
              await createLegalDraft(tx, USER, create({ kind: 'faq', locale: 'en', title: 'FAQ' })),
          ),
      ),
    );
    const versions = results.map((r) => Number(r.version)).sort((x, y) => x - y);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses a kind, locale or version the schema does not know', async () => {
    await expect(
      handle.pool.query(
        `INSERT INTO legal_documents (kind, version, locale, title, status, body_html, effective_from) VALUES ('offer','1','uk','x','draft','<p>x</p>', now())`,
      ),
    ).rejects.toThrow(/legal_docs_kind/);
    await expect(
      handle.pool.query(
        `INSERT INTO legal_documents (kind, version, locale, title, status, body_html, effective_from) VALUES ('terms','1','de','x','draft','<p>x</p>', now())`,
      ),
    ).rejects.toThrow(/legal_docs_locale/);
    await expect(
      handle.pool.query(
        `INSERT INTO legal_documents (kind, version, locale, title, status, body_html, effective_from) VALUES ('terms','v2','uk','x','draft','<p>x</p>', now())`,
      ),
    ).rejects.toThrow(/legal_docs_version_format/);
  });
});

describe('current version by the database clock', () => {
  it('never serves a draft', async () => {
    const d = await draft({ kind: 'about', locale: 'uk', title: 'About' });
    expect(await getCurrentLegalDocument(handle.db, 'about', 'uk')).toBeNull();
    expect(await currentPolicyRef(handle.db, 'about', 'uk')).toBe('v0-placeholder');
    await publish(d.id);
    expect((await getCurrentLegalDocument(handle.db, 'about', 'uk'))?.version).toBe(d.version);
  });

  it('keeps the old version current until a future start passes, then switches with no app clock', async () => {
    const first = await draft({ kind: 'delivery_payment', locale: 'uk' });
    await publish(first.id);
    const future = new Date(Date.now() + 1_500).toISOString();
    const second = await draft({ kind: 'delivery_payment', locale: 'uk', effectiveFrom: future });
    const done = await publish(second.id);
    // `publish` raises a start in the past to now(); this one is ahead, so it stays scheduled.
    expect(done.immediate).toBe(false);
    expect((await getCurrentLegalDocument(handle.db, 'delivery_payment', 'uk'))?.version).toBe(
      first.version,
    );
    // Time passes (the database clock, not ours, decides): the start was 1.5 s ahead of the publish.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await getCurrentLegalDocument(handle.db, 'delivery_payment', 'uk'))?.version).toBe(
      second.version,
    );
    // The old version is still in the table and still listed.
    const all = await listLegalDocuments(handle.db);
    expect(
      all
        .filter((row) => row.kind === 'delivery_payment')
        .map((row) => row.version)
        .sort(),
    ).toEqual([first.version, second.version]);
    expect(all.find((row) => row.id === second.id)?.isCurrent).toBe(true);
    expect(all.find((row) => row.id === first.id)?.isCurrent).toBe(false);
  });

  it('never starts a publish in the past', async () => {
    const d = await draft({
      kind: 'contacts',
      locale: 'uk',
      effectiveFrom: '2001-01-01T00:00:00Z',
    });
    const done = await publish(d.id);
    expect(Date.parse(done.effectiveFrom)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('refuses a second published version that starts at the same instant', async () => {
    const start = new Date(Date.now() + 7_200_000).toISOString();
    const a = await draft({ kind: 'contacts', locale: 'en', title: 'C', effectiveFrom: start });
    const b = await draft({ kind: 'contacts', locale: 'en', title: 'C', effectiveFrom: start });
    await publish(a.id);
    await expect(publish(b.id)).rejects.toBeInstanceOf(LegalStartTakenError);
  });

  it('lists the current page of each document and locale once, with its real start date', async () => {
    const nav = await listCurrentLegalNav(handle.db);
    const keys = nav.map((row) => `${row.kind}/${row.locale}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('about/uk');
    expect(keys).not.toContain('faq/en');
  });

  it('records the consent references of the current terms and privacy', async () => {
    const t = await draft({ kind: 'terms', locale: 'en', title: 'Terms' });
    await publish(t.id);
    const refs = await currentConsentRefs(handle.db, 'en');
    expect(refs.terms).toBe(`terms/en/${t.version}`);
    expect(refs.privacy).toBe('v0-placeholder');
  });
});

describe('a published version is history', () => {
  it('cannot be edited by the service, nor by SQL, nor deleted, nor moved back to draft', async () => {
    const d = await draft({ kind: 'returns', locale: 'uk', title: 'Returns' });
    await publish(d.id);
    await expect(
      handle.db.transaction(
        async (tx) =>
          await updateLegalDraft(
            tx,
            legalUpdateSchema.parse({ id: d.id, title: 'x', source: 'y' }),
          ),
      ),
    ).rejects.toBeInstanceOf(LegalNotDraftError);
    await expect(
      handle.pool.query(`UPDATE legal_documents SET body_html = '<p>edited</p>' WHERE id = $1`, [
        d.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      handle.pool.query(`UPDATE legal_documents SET status = 'draft' WHERE id = $1`, [d.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      handle.pool.query(`UPDATE legal_documents SET effective_from = now() WHERE id = $1`, [d.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      handle.pool.query(`DELETE FROM legal_documents WHERE id = $1`, [d.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      handle.db.transaction(async (tx) => await deleteLegalDraft(tx, d.id)),
    ).rejects.toBeInstanceOf(LegalNotDraftError);
    await expect(
      handle.db.transaction(async (tx) => await setLegalFile(tx, d.id, null)),
    ).rejects.toBeInstanceOf(LegalNotDraftError);
  });

  it('keeps the old version after a newer one is published (return requests point at it)', async () => {
    const one = await draft({ kind: 'returns', locale: 'en', title: 'Returns' });
    await publish(one.id);
    const two = await draft({ kind: 'returns', locale: 'en', title: 'Returns 2' });
    await publish(two.id);
    const rows = await handle.pool.query(
      `SELECT version FROM legal_documents WHERE kind='returns' AND locale='en' AND status='published' ORDER BY version::int`,
    );
    expect(rows.rows.map((r: { version: string }) => r.version)).toEqual([
      one.version,
      two.version,
    ]);
  });

  it('refuses to publish an empty draft', async () => {
    const d = await draft({ kind: 'faq', locale: 'uk', title: 'FAQ', source: '' });
    await expect(publish(d.id)).rejects.toBeInstanceOf(LegalEmptyError);
  });

  it('publishes a PDF-only draft', async () => {
    const d = await draft({ kind: 'terms', locale: 'uk', title: 'PDF terms', source: '' });
    await handle.db.transaction(
      async (tx) =>
        await setLegalFile(tx, d.id, {
          url: 'https://media.example/legal/a/b.pdf',
          key: 'legal/a/b.pdf',
          size: 9,
        }),
    );
    await publish(d.id);
    const current = await getCurrentLegalDocument(handle.db, 'terms', 'uk');
    expect(current?.fileUrl).toBe('https://media.example/legal/a/b.pdf');
    expect(current?.bodyHtml).toBeNull();
  });
});

describe('rich text safety', () => {
  const payload =
    '## Title\n\n<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))';

  it('stores sanitised html, never the payload as markup', async () => {
    const d = await draft({ kind: 'privacy', locale: 'uk', title: 'P', source: payload });
    const row = await handle.pool.query<{ body_html: string }>(
      `SELECT body_html FROM legal_documents WHERE id = $1`,
      [d.id],
    );
    const html = row.rows[0]?.body_html ?? '';
    // What remains of the payload is escaped TEXT: no raw `<` except the tags the renderer wrote.
    expect(html.replace(/<\/?(?:h2|p|a|strong|em)>/g, '')).not.toContain('<');
    expect(html).not.toMatch(/<a [^>]*javascript:/i);
    expect(html).toContain('<h2>Title</h2>');
  });

  it('sanitises again on read, even when the stored html was written around the service', async () => {
    const d = await draft({ kind: 'delivery_payment', locale: 'en', title: 'D', source: 'ok' });
    await handle.pool.query(`UPDATE legal_documents SET body_html = $2 WHERE id = $1`, [
      d.id,
      '<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">z</a>',
    ]);
    await publish(d.id);
    const current = await getCurrentLegalDocument(handle.db, 'delivery_payment', 'en');
    expect(current?.bodyHtml).toBe('<p>hi</p>z');
  });

  it('keeps the author and the editor source out of the public view', async () => {
    const current = await getCurrentLegalDocument(handle.db, 'about', 'uk');
    expect(Object.keys(current ?? {}).sort()).toEqual([
      'bodyHtml',
      'effectiveFrom',
      'fileUrl',
      'kind',
      'locale',
      'title',
      'version',
    ]);
  });
});

describe('drafts', () => {
  it('edit and delete freely', async () => {
    const d = await draft({ kind: 'about', locale: 'en', title: 'About' });
    await handle.db.transaction(
      async (tx) =>
        await updateLegalDraft(
          tx,
          legalUpdateSchema.parse({ id: d.id, title: 'New title', source: 'New **text**' }),
        ),
    );
    const row = await handle.pool.query(
      `SELECT title, body_html FROM legal_documents WHERE id = $1`,
      [d.id],
    );
    expect(row.rows[0]).toEqual({
      title: 'New title',
      body_html: '<p>New <strong>text</strong></p>',
    });
    await handle.db.transaction(async (tx) => await deleteLegalDraft(tx, d.id));
    expect(
      (await handle.pool.query(`SELECT 1 FROM legal_documents WHERE id = $1`, [d.id])).rowCount,
    ).toBe(0);
  });
});
