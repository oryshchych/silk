/**
 * Development and staging seed: the neutral legal DRAFT texts (`@store/shared/legal-drafts`, "Draft: needs a
 * lawyer") as version 1 of every document in both languages, so the public pages, the footer and the sitemap
 * have something to show. Never run on production (the seed refuses it). The texts carry their own visible
 * "draft" notice; the real texts are published through the admin as new versions (owner queue Q77).
 */
import { sql } from 'drizzle-orm';

import { legalDraft } from '@store/shared/legal-drafts';
import { LEGAL_KINDS, LEGAL_LOCALES } from '@store/shared/legal';
import { markdownToHtml } from '@store/shared/rich-text';

import type { Tx } from '../src/types.ts';

export async function seedLegal(tx: Tx): Promise<number> {
  let count = 0;
  for (const kind of LEGAL_KINDS) {
    for (const locale of LEGAL_LOCALES) {
      const draft = legalDraft(kind, locale);
      await tx.execute(
        sql`INSERT INTO legal_documents (kind, locale, version, title, status, body_source, body_html, effective_from, published_at)
            VALUES (${kind}, ${locale}, '1', ${draft.title}, 'published', ${draft.source}, ${markdownToHtml(draft.source)},
                    now() - interval '1 day', now() - interval '1 day')
            ON CONFLICT DO NOTHING`,
      );
      count += 1;
    }
  }
  return count;
}
