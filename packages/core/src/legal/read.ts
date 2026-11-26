/**
 * Legal documents, public side. "The current version" of a document is the PUBLISHED one with the latest
 * `effective_from` that is not after the DATABASE's now(): no application clock takes part, so a version
 * scheduled for the future is invisible until the database says its time came, and an old version is never
 * served after a newer one took over. A draft is never selected (status filter in every query).
 *
 * The html is sanitised AGAIN here, on every read, whatever the row holds.
 */
import { sql } from 'drizzle-orm';

import type { Reader } from '@store/db/types';
import {
  legalNavDto,
  publicLegalDto,
  type LegalNavDto,
  type PublicLegalDto,
} from '@store/shared/dto/legal';
import { serialize } from '@store/shared/dto/serialize';
import {
  CONSENT_KINDS,
  NO_POLICY_REF,
  policyRef,
  type LegalKind,
  type LegalLocale,
} from '@store/shared/legal';
import { safeHref, sanitizeHtml } from '@store/shared/rich-text';

const CURRENT = sql`status = 'published' AND effective_from <= now()`;

export async function getCurrentLegalDocument(
  reader: Reader,
  kind: LegalKind,
  locale: LegalLocale,
  /** The origin of `MEDIA_PUBLIC_BASE_URL`: a file link on any other host is dropped (null: no file link at all). */
  mediaOrigin: string | null = null,
): Promise<PublicLegalDto | null> {
  const result = await reader.execute<{
    kind: string;
    locale: string;
    version: string;
    title: string;
    body_html: string | null;
    file_url: string | null;
    effective_from: Date;
  }>(
    sql`SELECT kind, locale, version, title, body_html, file_url, effective_from
          FROM legal_documents
         WHERE kind = ${kind} AND locale = ${locale} AND ${CURRENT}
         ORDER BY effective_from DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  // An oversized or over-nested row (written around the service) must not take the page down: no text.
  const html = ((): string | null => {
    if ((row.body_html ?? '').trim() === '') return null;
    try {
      return sanitizeHtml(row.body_html ?? '');
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  })();
  // Only an https link on the media host is ever handed out.
  const fileUrl = pinnedFileUrl(row.file_url, mediaOrigin);
  return serialize(publicLegalDto, {
    kind: row.kind,
    locale: row.locale,
    version: row.version,
    title: row.title,
    bodyHtml: html,
    fileUrl,
    effectiveFrom: new Date(row.effective_from).toISOString(),
  });
}

/** The current version of every document in every locale, one row each (footer, sitemap, hreflang). */
export async function listCurrentLegalNav(reader: Reader): Promise<LegalNavDto[]> {
  const result = await reader.execute<{
    kind: string;
    locale: string;
    version: string;
    title: string;
    effective_from: Date;
  }>(
    sql`SELECT DISTINCT ON (kind, locale) kind, locale, version, title, effective_from
          FROM legal_documents WHERE ${CURRENT}
         ORDER BY kind, locale, effective_from DESC`,
  );
  return result.rows.map((row) =>
    serialize(legalNavDto, {
      kind: row.kind,
      locale: row.locale,
      version: row.version,
      title: row.title,
      effectiveFrom: new Date(row.effective_from).toISOString(),
    }),
  );
}

/** The reference of the CURRENT version of a document, or the placeholder when none is published. */
export async function currentPolicyRef(
  reader: Reader,
  kind: LegalKind,
  locale: LegalLocale,
): Promise<string> {
  const result = await reader.execute<{ version: string }>(
    sql`SELECT version FROM legal_documents
         WHERE kind = ${kind} AND locale = ${locale} AND ${CURRENT}
         ORDER BY effective_from DESC LIMIT 1`,
  );
  const version = result.rows[0]?.version;
  return version === undefined ? NO_POLICY_REF : policyRef(kind, locale, version);
}

/** What a checkout or sign-up acceptance stores: the current terms and privacy references. */
export async function currentConsentRefs(
  reader: Reader,
  locale: LegalLocale,
): Promise<Record<(typeof CONSENT_KINDS)[number], string>> {
  const [terms, privacy] = await Promise.all(
    CONSENT_KINDS.map((kind) => currentPolicyRef(reader, kind, locale)),
  );
  return { terms: terms ?? NO_POLICY_REF, privacy: privacy ?? NO_POLICY_REF };
}

/** For the sitemap: the real date each current page took effect. */
export async function listLegalForSitemap(
  reader: Reader,
): Promise<{ kind: LegalKind; locale: LegalLocale; lastmod: Date }[]> {
  const nav = await listCurrentLegalNav(reader);
  return nav.map((row) => ({
    kind: row.kind,
    locale: row.locale,
    lastmod: new Date(row.effectiveFrom),
  }));
}

function pinnedFileUrl(fileUrl: string | null, mediaOrigin: string | null): string | null {
  if (fileUrl === null || mediaOrigin === null || !/^https:\/\//.test(fileUrl)) return null;
  const safe = safeHref(fileUrl);
  if (safe === null) return null;
  try {
    return new URL(safe).origin === mediaOrigin ? safe : null;
  } catch {
    return null;
  }
}
