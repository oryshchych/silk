/**
 * The category tree. Depth is stored (0 to 3, a CHECK), so a move recomputes the depth of the whole
 * subtree in one UPDATE, refuses a cycle, and refuses a move that would push a descendant past the
 * limit. A changed slug leaves a 301.
 */
import { eq, sql } from 'drizzle-orm';

import { categories } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { CATEGORIES_TAG, categoryTag, listingTag } from '@store/shared/cache-tags';

import { AdminNotFoundError, CategoryCycleError, CategoryTooDeepError } from './errors.ts';
import { diffOf, mapUnique, type AdminOutcome } from './outcome.ts';
import { recordSlugRedirects, releaseSlugPaths } from './redirects.ts';

const MAX_DEPTH = 3;

/** A category change refreshes its own page and breadcrumbs AND the listings that show it. */
const tagsOf = (ids: readonly string[]): string[] => [
  ...new Set(ids.flatMap((id) => [categoryTag(id), listingTag(id)])),
];

async function loadCategory(tx: Tx, categoryId: string) {
  const [row] = await tx.select().from(categories).where(eq(categories.id, categoryId));
  if (row === undefined) throw new AdminNotFoundError('category');
  return row;
}

/** The category and every ancestor above it (ids, nearest first). */
async function chainOf(tx: Tx, categoryId: string | null): Promise<string[]> {
  if (categoryId === null) return [];
  const rows = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS n FROM categories WHERE id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id, c.parent_id, up.n + 1 FROM categories c JOIN up ON c.id = up.parent_id
      WHERE up.n < 8
    )
    SELECT id FROM up ORDER BY n`);
  return rows.rows.map((row) => row.id);
}

/** The category and every descendant, with the deepest level found. */
async function subtreeOf(tx: Tx, categoryId: string): Promise<{ ids: string[]; maxDepth: number }> {
  const rows = await tx.execute<{ id: string; depth: number }>(sql`
    WITH RECURSIVE down AS (
      SELECT id, depth, 0 AS n FROM categories WHERE id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id, c.depth, down.n + 1 FROM categories c JOIN down ON c.parent_id = down.id
      WHERE down.n < 8
    )
    SELECT id, depth FROM down`);
  return {
    ids: rows.rows.map((row) => row.id),
    maxDepth: Math.max(...rows.rows.map((row) => row.depth)),
  };
}

export async function createCategory(
  tx: Tx,
  input: {
    parentId: string | null;
    slug: string;
    nameUk: string;
    nameEn: string;
    sizeSystem?: 'bra' | 'panty' | 'apparel' | 'onesize' | null | undefined;
  },
): Promise<AdminOutcome<{ categoryId: string }>> {
  let depth = 0;
  if (input.parentId !== null) {
    const parent = await loadCategory(tx, input.parentId);
    depth = parent.depth + 1;
    if (depth > MAX_DEPTH) throw new CategoryTooDeepError();
  }
  const created = await mapUnique(tx, async (inner) => {
    const [row] = await inner
      .insert(categories)
      .values({
        parentId: input.parentId,
        slug: input.slug,
        nameUk: input.nameUk,
        nameEn: input.nameEn,
        sizeSystem: input.sizeSystem ?? null,
        depth,
      })
      .returning({ id: categories.id });
    if (row === undefined) throw new Error('category insert returned no row');
    return row;
  });
  await releaseSlugPaths(tx, 'category', input.slug);
  return {
    data: { categoryId: created.id },
    audit: {
      action: 'create',
      entity: 'category',
      entityId: created.id,
      diff: { slug: input.slug, parentId: input.parentId },
    },
    tags: [CATEGORIES_TAG, ...tagsOf(await chainOf(tx, created.id))],
  };
}

const UPDATE_KEYS = [
  'slug',
  'nameUk',
  'nameEn',
  'descriptionUk',
  'descriptionEn',
  'seoTextUk',
  'seoTextEn',
  'sizeSystem',
  'isActive',
  'noindex',
  'metaTitleUk',
  'metaTitleEn',
  'metaDescriptionUk',
  'metaDescriptionEn',
  'sortOrder',
] as const;

export async function updateCategory(
  tx: Tx,
  input: { categoryId: string } & Partial<Record<(typeof UPDATE_KEYS)[number], unknown>>,
): Promise<AdminOutcome<{ changed: string[] }>> {
  const before = await loadCategory(tx, input.categoryId);
  const set = Object.fromEntries(
    UPDATE_KEYS.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
  );
  const diff = diffOf(before, set, UPDATE_KEYS);
  if (Object.keys(diff).length > 0) {
    await mapUnique(tx, async (inner) => {
      await inner.update(categories).set(set).where(eq(categories.id, input.categoryId));
    });
    const slug = set['slug'];
    if (typeof slug === 'string' && slug !== before.slug) {
      await recordSlugRedirects(tx, { kind: 'category', fromSlug: before.slug, toSlug: slug });
    }
  }
  return {
    data: { changed: Object.keys(diff) },
    audit: { action: 'update', entity: 'category', entityId: input.categoryId, diff },
    tags:
      Object.keys(diff).length === 0
        ? []
        : [CATEGORIES_TAG, ...tagsOf(await chainOf(tx, input.categoryId))],
  };
}

export async function moveCategory(
  tx: Tx,
  input: { categoryId: string; parentId: string | null; sortOrder?: number | undefined },
): Promise<AdminOutcome<{ depth: number }>> {
  // One move at a time: the cycle check reads the tree and the update changes it, so two moves
  // racing (A under B, B under A) could each pass the check and together make a cycle.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('categories-tree', 0))`);
  const category = await loadCategory(tx, input.categoryId);
  const subtree = await subtreeOf(tx, input.categoryId);
  if (input.parentId !== null && subtree.ids.includes(input.parentId)) {
    throw new CategoryCycleError();
  }
  const newDepth = input.parentId === null ? 0 : (await loadCategory(tx, input.parentId)).depth + 1;
  if (newDepth + (subtree.maxDepth - category.depth) > MAX_DEPTH) throw new CategoryTooDeepError();
  const oldChain = await chainOf(tx, category.parentId);
  const newChain = await chainOf(tx, input.parentId);

  const shift = newDepth - category.depth;
  await tx
    .update(categories)
    .set({
      depth: sql`${categories.depth} + ${shift}`,
    })
    .where(
      sql`${categories.id} IN (${sql.join(
        subtree.ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  await tx
    .update(categories)
    .set({
      parentId: input.parentId,
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    })
    .where(eq(categories.id, input.categoryId));
  return {
    data: { depth: newDepth },
    audit: {
      action: 'update',
      entity: 'category',
      entityId: input.categoryId,
      diff: { parentId: { from: category.parentId, to: input.parentId } },
    },
    tags: [CATEGORIES_TAG, ...tagsOf([input.categoryId, ...oldChain, ...newChain, ...subtree.ids])],
  };
}
