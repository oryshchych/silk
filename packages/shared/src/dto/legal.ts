/**
 * Legal documents as served. The PUBLIC view carries what a reader sees (title, sanitised html, the PDF link,
 * the dates) and nothing about who wrote it. The ADMIN view adds the editor's source text, the status and
 * the author ids. Explicit field lists: an unknown column never passes (AGENTS.md section 4b.3).
 */
import { z } from 'zod';

import { LEGAL_KINDS, LEGAL_LOCALES } from '../legal';

export const publicLegalDto = z.object({
  kind: z.enum(LEGAL_KINDS),
  locale: z.enum(LEGAL_LOCALES),
  version: z.string(),
  title: z.string(),
  /** Already passed through the allowlist sanitiser on this read. */
  bodyHtml: z.string().nullable(),
  fileUrl: z.string().nullable(),
  effectiveFrom: z.iso.datetime({ offset: true }),
});

export const legalNavDto = z.object({
  kind: z.enum(LEGAL_KINDS),
  locale: z.enum(LEGAL_LOCALES),
  title: z.string(),
  version: z.string(),
  effectiveFrom: z.iso.datetime({ offset: true }),
});

export const adminLegalListDto = z.object({
  id: z.uuid(),
  kind: z.enum(LEGAL_KINDS),
  locale: z.enum(LEGAL_LOCALES),
  version: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'published']),
  effectiveFrom: z.iso.datetime({ offset: true }),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  hasFile: z.boolean(),
  /** Published and its start has passed by the database clock: this is what the public sees now. */
  isCurrent: z.boolean(),
});

export const adminLegalDto = adminLegalListDto.extend({
  bodySource: z.string().nullable(),
  fileUrl: z.string().nullable(),
  fileSize: z.number().int().nullable(),
});

export type PublicLegalDto = z.output<typeof publicLegalDto>;
export type LegalNavDto = z.output<typeof legalNavDto>;
export type AdminLegalListDto = z.output<typeof adminLegalListDto>;
export type AdminLegalDto = z.output<typeof adminLegalDto>;
