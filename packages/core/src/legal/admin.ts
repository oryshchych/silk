/**
 * Legal documents, admin side (`legal.edit` writes drafts, `legal.publish` publishes). The rules live in the
 * database where they can (migration 0021): a published version is immutable and never deleted, no two
 * published versions of a document start at the same instant, kind and locale are closed lists. This module
 * adds what a row cannot say: the version number is `max + 1` per (kind, locale) under an advisory lock, the
 * text is turned into SANITISED html on write (the Markdown the editor types is kept as the source), and a
 * publish never starts in the past, so history cannot be rewritten.
 *
 * "Current" is decided by the DATABASE clock (`effective_from <= now()`), in `./read.ts`, never here.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader, Tx } from '@store/db/types';
import { adminLegalDto, adminLegalListDto } from '@store/shared/dto/legal';
import type { AdminLegalDto, AdminLegalListDto } from '@store/shared/dto/legal';
import { serialize } from '@store/shared/dto/serialize';
import { LEGAL_KINDS, LEGAL_LOCALES, type LegalKind, type LegalLocale } from '@store/shared/legal';
import { markdownToHtml, MAX_RICH_TEXT_CHARS } from '@store/shared/rich-text';

import { DomainError } from '../errors.ts';

export class LegalNotFoundError extends DomainError {
  constructor() {
    super('LEGAL_NOT_FOUND', 'Legal document not found');
  }
}
export class LegalNotDraftError extends DomainError {
  constructor() {
    super('LEGAL_NOT_DRAFT', 'A published version cannot be changed: create a new version');
  }
}
export class LegalEmptyError extends DomainError {
  constructor() {
    super('LEGAL_EMPTY', 'The document has neither a text nor a file');
  }
}
export class LegalSupersededError extends DomainError {
  constructor() {
    super(
      'LEGAL_START_TOO_EARLY',
      'A published version of this document already starts later: this one would be replaced by an older text',
    );
  }
}
export class LegalInvalidBodyError extends DomainError {
  constructor() {
    super('INVALID_INPUT', 'The text is too long or nested too deeply');
  }
}
export class LegalStartTakenError extends DomainError {
  constructor() {
    super('LEGAL_START_TAKEN', 'Another published version starts at the same time');
  }
}

const clean = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '');

const titleSchema = z
  .string()
  .transform((value) => clean(value).trim())
  .pipe(z.string().min(1).max(200));
const sourceSchema = z
  .string()
  .max(MAX_RICH_TEXT_CHARS)
  .transform((value) => clean(value))
  .transform((value) => (value.trim() === '' ? null : value));
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** A start more than a year ahead is a typo, and a published version cannot be taken back (sanity bound, the database clock decides "current"). */
const startSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) <= Date.now() + MAX_AHEAD_MS);

export const legalCreateSchema = z.object({
  kind: z.enum(LEGAL_KINDS),
  locale: z.enum(LEGAL_LOCALES),
  title: titleSchema,
  source: sourceSchema,
  /** When the version becomes public, if published. Defaults to the moment it is published. */
  effectiveFrom: startSchema.optional(),
});
export const legalUpdateSchema = z.object({
  id: z.uuid(),
  title: titleSchema,
  source: sourceSchema,
  effectiveFrom: startSchema.optional(),
});
export const legalIdSchema = z.object({ id: z.uuid() });
export type LegalCreateInput = z.output<typeof legalCreateSchema>;
export type LegalUpdateInput = z.output<typeof legalUpdateSchema>;

/**
 * The stored html for a source: rendered and sanitised. An empty source is the empty string (not null), so a
 * draft that is still being written satisfies `legal_docs_has_content`; publishing refuses an empty one.
 */
export function renderLegalSource(source: string | null): string {
  if (source === null) return '';
  try {
    return markdownToHtml(source);
  } catch (error) {
    // The sanitiser refuses an oversized or deeply nested text: a refusal of the input, not a crash.
    if (error instanceof RangeError) throw new LegalInvalidBodyError();
    throw error;
  }
}

export async function createLegalDraft(
  tx: Tx,
  userId: string,
  input: LegalCreateInput,
): Promise<{ id: string; version: string }> {
  // One writer per document at a time, so two drafts cannot pick the same number.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`legal:${input.kind}:${input.locale}`}))`,
  );
  const next = await tx.execute<{ v: number }>(
    sql`SELECT coalesce(max(version::int), 0) + 1 AS v FROM legal_documents
         WHERE kind = ${input.kind} AND locale = ${input.locale}`,
  );
  const version = String(next.rows[0]?.v ?? 1);
  const created = await tx.execute<{ id: string }>(
    sql`INSERT INTO legal_documents (kind, locale, version, title, status, body_source, body_html, effective_from, uploaded_by_user_id)
        VALUES (${input.kind}, ${input.locale}, ${version}, ${input.title}, 'draft', ${input.source},
                ${renderLegalSource(input.source)}, coalesce(${input.effectiveFrom ?? null}::timestamptz, now()), ${userId}::uuid)
        RETURNING id`,
  );
  const id = created.rows[0]?.id;
  if (id === undefined) throw new Error('legal insert returned no row');
  return { id, version };
}

/** Edits a DRAFT. A published version is refused by the guard in the SQL (and its row is not matched here). */
export async function updateLegalDraft(
  tx: Tx,
  input: LegalUpdateInput,
): Promise<{ kind: LegalKind; locale: LegalLocale }> {
  const done = await tx.execute<{ kind: LegalKind; locale: LegalLocale }>(
    sql`UPDATE legal_documents
           SET title = ${input.title}, body_source = ${input.source}, body_html = ${renderLegalSource(input.source)},
               effective_from = coalesce(${input.effectiveFrom ?? null}::timestamptz, effective_from)
         WHERE id = ${input.id}::uuid AND status = 'draft' RETURNING kind, locale`,
  );
  const row = done.rows[0];
  if (row !== undefined) return row;
  await assertExists(tx, input.id);
  throw new LegalNotDraftError();
}

export async function deleteLegalDraft(
  tx: Tx,
  id: string,
): Promise<{ kind: LegalKind; locale: LegalLocale; fileKey: string | null }> {
  const done = await tx.execute<{ kind: LegalKind; locale: LegalLocale; file_key: string | null }>(
    sql`DELETE FROM legal_documents WHERE id = ${id}::uuid AND status = 'draft' RETURNING kind, locale, file_key`,
  );
  const row = done.rows[0];
  if (row !== undefined) return { kind: row.kind, locale: row.locale, fileKey: row.file_key };
  await assertExists(tx, id);
  throw new LegalNotDraftError();
}

/** Records (or removes, with null) the PDF of a draft. The object itself is uploaded by the route. */
export async function setLegalFile(
  tx: Tx,
  id: string,
  file: { url: string; key: string; size: number } | null,
): Promise<{ previousKey: string | null }> {
  // One writer per document at a time, so the key that is replaced is the key that was there.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`legal-file:${id}`}))`);
  const before = await tx.execute<{ file_key: string | null }>(
    sql`SELECT file_key FROM legal_documents WHERE id = ${id}::uuid AND status = 'draft'`,
  );
  const row = before.rows[0];
  if (row === undefined) {
    await assertExists(tx, id);
    throw new LegalNotDraftError();
  }
  await tx.execute(
    sql`UPDATE legal_documents SET file_url = ${file?.url ?? null}, file_key = ${file?.key ?? null}, file_size = ${file?.size ?? null}
         WHERE id = ${id}::uuid`,
  );
  return { previousKey: row.file_key };
}

async function assertExists(reader: Reader, id: string): Promise<void> {
  const found = await reader.execute(sql`SELECT 1 FROM legal_documents WHERE id = ${id}::uuid`);
  if (found.rows.length === 0) throw new LegalNotFoundError();
}

/**
 * Publishes a draft. It needs a text or a file. The start is never earlier than the database's now(): a
 * version cannot be made to have been in force in the past. A start in the future is fine (the previous
 * version stays current until then, by the database clock). Returns what the caller must invalidate.
 */
export async function publishLegalDocument(
  tx: Tx,
  userId: string,
  id: string,
): Promise<{
  kind: LegalKind;
  locale: LegalLocale;
  version: string;
  effectiveFrom: string;
  immediate: boolean;
}> {
  // One publisher per document, and a version may not start before one that is already published: when its
  // start came, the older text would silently become current again over the newer one, and a published row
  // can never be taken back.
  const target = await tx.execute<{ kind: LegalKind; locale: LegalLocale }>(
    sql`SELECT kind, locale FROM legal_documents WHERE id = ${id}::uuid AND status = 'draft'`,
  );
  const wanted = target.rows[0];
  if (wanted !== undefined) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`legal:${wanted.kind}:${wanted.locale}`}))`,
    );
    const later = await tx.execute(
      sql`SELECT 1 FROM legal_documents d, legal_documents me
           WHERE me.id = ${id}::uuid AND d.kind = me.kind AND d.locale = me.locale AND d.status = 'published'
             AND d.effective_from > greatest(me.effective_from, now()) LIMIT 1`,
    );
    if (later.rows.length > 0) throw new LegalSupersededError();
  }
  try {
    const done = await tx.execute<{
      kind: LegalKind;
      locale: LegalLocale;
      version: string;
      effective_from: Date;
      immediate: boolean;
    }>(
      sql`UPDATE legal_documents
             SET status = 'published', published_at = now(), published_by_user_id = ${userId}::uuid,
                 effective_from = greatest(effective_from, now())
           WHERE id = ${id}::uuid AND status = 'draft'
             AND (btrim(coalesce(body_html, '')) <> '' OR file_url IS NOT NULL)
       RETURNING kind, locale, version, effective_from, effective_from <= now() AS immediate`,
    );
    const published = done.rows[0];
    if (published !== undefined) {
      return {
        kind: published.kind,
        locale: published.locale,
        version: published.version,
        effectiveFrom: new Date(published.effective_from).toISOString(),
        immediate: published.immediate,
      };
    }
  } catch (error) {
    if (pgCode(error) === '23505') throw new LegalStartTakenError();
    throw error;
  }
  // Nothing was published: say why (a draft with no content, a version already published, no such id).
  await assertLegalDraft(tx, id);
  throw new LegalEmptyError();
}

/** The SQLSTATE of a database error, looking through `cause` (the driver error may be wrapped). */
function pgCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'cause' in error ? pgCode(error.cause) : null;
}

type AdminRow = {
  id: string;
  kind: string;
  locale: string;
  version: string;
  title: string;
  status: string;
  effective_from: Date;
  published_at: Date | null;
  has_file: boolean;
  is_current: boolean;
  body_source: string | null;
  file_url: string | null;
  file_size: number | null;
};

const ADMIN_COLUMNS = sql`d.id, d.kind, d.locale, d.version, d.title, d.status, d.effective_from, d.published_at,
  d.file_url IS NOT NULL AS has_file, d.body_source, d.file_url, d.file_size,
  (d.status = 'published' AND d.effective_from <= now()
     AND d.effective_from = (SELECT max(c.effective_from) FROM legal_documents c
                              WHERE c.kind = d.kind AND c.locale = d.locale AND c.status = 'published' AND c.effective_from <= now())) AS is_current`;

const toListDto = (row: AdminRow): AdminLegalListDto =>
  serialize(adminLegalListDto, {
    id: row.id,
    kind: row.kind,
    locale: row.locale,
    version: row.version,
    title: row.title,
    status: row.status,
    effectiveFrom: new Date(row.effective_from).toISOString(),
    publishedAt: row.published_at === null ? null : new Date(row.published_at).toISOString(),
    hasFile: row.has_file,
    isCurrent: row.is_current,
  });

/** Every version of every document, newest first within a document. No body. */
export async function listLegalDocuments(reader: Reader): Promise<AdminLegalListDto[]> {
  const result = await reader.execute<AdminRow>(
    sql`SELECT ${ADMIN_COLUMNS} FROM legal_documents d
         ORDER BY d.kind, d.locale, d.version::int DESC LIMIT 500`,
  );
  return result.rows.map(toListDto);
}

export async function getLegalDocumentAdmin(reader: Reader, id: string): Promise<AdminLegalDto> {
  const result = await reader.execute<AdminRow>(
    sql`SELECT ${ADMIN_COLUMNS} FROM legal_documents d WHERE d.id = ${id}::uuid`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new LegalNotFoundError();
  return serialize(adminLegalDto, {
    ...toListDto(row),
    bodySource: row.body_source,
    fileUrl: row.file_url,
    fileSize: row.file_size,
  });
}

/** The object key of a legal PDF: ids and fixed words only, so a file name can never reach a key. */
export const legalPdfKey = (documentId: string, objectId: string): string =>
  `legal/${documentId}/${objectId}.pdf`;

/** The cheapest check before a PDF is stored: the document exists and is still a draft. */
export async function assertLegalDraft(reader: Reader, id: string): Promise<void> {
  const found = await reader.execute<{ status: string }>(
    sql`SELECT status FROM legal_documents WHERE id = ${id}::uuid`,
  );
  const row = found.rows[0];
  if (row === undefined) throw new LegalNotFoundError();
  if (row.status !== 'draft') throw new LegalNotDraftError();
}
