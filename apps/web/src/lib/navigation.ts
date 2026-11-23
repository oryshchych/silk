import { buildCategoryTree, type CategoryNode } from '@store/core/catalog';
import type { SiteLocale } from '@store/shared/seo';

import { getCachedCategories } from './catalog';
import { errorReason } from './error-reason';

/** Last tree that loaded, per locale: served when the database is unreachable (stale-on-error, as ADR-14). */
const lastGood = new Map<SiteLocale, CategoryNode[]>();

/**
 * Category tree for the header and the home page.
 *
 * If the database is unreachable the last good tree is used, so a short
 * outage does not take the navigation away. With no good tree yet (a cold
 * start during an outage) the error is rethrown, so a cached (ISR) page is
 * never regenerated without navigation: Next keeps serving the previous entry
 * or answers 500. `degrade` is for pages that are rendered per request and
 * never cached (the home page): they render without navigation instead, and
 * the failure goes to stderr as one line with the error name and code only
 * (no query text or parameters).
 */
export async function loadCategoryTree(
  locale: SiteLocale,
  options: { degrade?: boolean } = {},
): Promise<CategoryNode[]> {
  try {
    const tree = buildCategoryTree(await getCachedCategories(locale));
    lastGood.set(locale, tree);
    return tree;
  } catch (error) {
    const stale = lastGood.get(locale);
    if (stale === undefined && options.degrade !== true) throw error;
    const reason = errorReason(error);
    process.stderr.write(`${JSON.stringify({ level: 'error', scope: 'navigation', reason })}\n`);
    return stale ?? [];
  }
}
