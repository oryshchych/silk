import { buildCategoryTree, type CategoryNode } from '@store/core/catalog';
import type { SiteLocale } from '@store/shared/seo';

import { getCachedCategories } from './catalog';

/** Last tree that loaded, per locale: served when the database is unreachable (stale-on-error, as ADR-14). */
const lastGood = new Map<SiteLocale, CategoryNode[]>();

/**
 * Category tree for the header and the home page.
 *
 * If the database is unreachable the last good tree is used, so an ISR
 * regeneration during a short outage does not replace a good page with one
 * without navigation. Only a cold start during an outage renders an empty
 * navigation (the page still serves, the error goes to stderr); that page is
 * then cached until its next regeneration.
 */
export async function loadCategoryTree(locale: SiteLocale): Promise<CategoryNode[]> {
  try {
    const tree = buildCategoryTree(await getCachedCategories(locale));
    lastGood.set(locale, tree);
    return tree;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : 'unknown error').split('\n')[0];
    process.stderr.write(`${JSON.stringify({ level: 'error', scope: 'navigation', reason })}\n`);
    return lastGood.get(locale) ?? [];
  }
}
