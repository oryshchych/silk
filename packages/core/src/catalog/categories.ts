/**
 * Category tree (3 levels) and category pages. The whole active tree is one
 * small query; ancestors, breadcrumbs and "include subcategories" are derived
 * in memory, so a category page costs two queries however deep it is.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import {
  categoryDto,
  categoryPageDto,
  type CategoryDto,
  type CategoryPageDto,
  type CrumbDto,
} from '@store/shared/dto/catalog';
import { serialize } from '@store/shared/dto/serialize';

import { localized, queryRows, type SiteLocale } from './sql.ts';

const sizeSystem = z.enum(['bra', 'panty', 'apparel', 'onesize']);

const categoryRow = z.object({
  id: z.uuid(),
  parent_id: z.uuid().nullable(),
  slug: z.string(),
  name: z.string(),
  depth: z.number().int(),
  image_url: z.string().nullable(),
  description: z.string().nullable(),
  seo_text: z.string().nullable(),
  meta_title: z.string().nullable(),
  meta_description: z.string().nullable(),
  noindex: z.boolean(),
  size_system: sizeSystem.nullable(),
});

type CategoryRow = z.output<typeof categoryRow>;

async function loadActive(reader: Reader, locale: SiteLocale): Promise<CategoryRow[]> {
  const rows = await queryRows(
    reader,
    categoryRow,
    sql`SELECT c.id, c.parent_id, c.slug, ${localized('c', 'name', locale)} AS name, c.depth,
               c.image_url, ${localized('c', 'description', locale)} AS description,
               ${localized('c', 'seo_text', locale)} AS seo_text,
               ${localized('c', 'meta_title', locale)} AS meta_title,
               ${localized('c', 'meta_description', locale)} AS meta_description,
               c.noindex, c.size_system
          FROM categories c
         WHERE c.is_active
         ORDER BY c.depth, c.sort_order, c.id`,
  );
  // A child of an inactive parent is unreachable from the storefront.
  const reachable = new Set<string>();
  return rows.filter((row) => {
    if (row.parent_id !== null && !reachable.has(row.parent_id)) return false;
    reachable.add(row.id);
    return true;
  });
}

export async function getCategories(reader: Reader, locale: SiteLocale): Promise<CategoryDto[]> {
  const rows = await loadActive(reader, locale);
  return rows.map((row) =>
    serialize(categoryDto, {
      id: row.id,
      parentId: row.parent_id,
      slug: row.slug,
      name: row.name,
      depth: row.depth,
      imageUrl: row.image_url,
    }),
  );
}

export interface CategoryNode extends CategoryDto {
  children: CategoryNode[];
}

/** Nests a flat, ordered category list. Pure. */
export function buildCategoryTree(flat: readonly CategoryDto[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>(flat.map((c) => [c.id, { ...c, children: [] }]));
  const roots: CategoryNode[] = [];
  for (const category of flat) {
    const node = nodes.get(category.id);
    if (node === undefined) continue;
    const parent = category.parentId === null ? undefined : nodes.get(category.parentId);
    (parent === undefined ? roots : parent.children).push(node);
  }
  return roots;
}

/** Ids of `rootId` and every descendant. Pure. */
export function collectCategoryIds(
  flat: readonly { id: string; parentId: string | null }[],
  rootId: string,
): string[] {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    for (const category of flat) if (category.parentId === ids[i]) ids.push(category.id);
  }
  return ids;
}

function ancestry(rows: readonly CategoryRow[], id: string): CrumbDto[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const crumbs: CrumbDto[] = [];
  for (let at = byId.get(id); at !== undefined; at = byId.get(at.parent_id ?? '')) {
    crumbs.unshift({ slug: at.slug, name: at.name });
  }
  return crumbs;
}

export interface CategoryPage {
  page: CategoryPageDto;
  /** The category and all its descendants, for the product listing. */
  categoryIds: string[];
}

export async function getCategoryPage(
  reader: Reader,
  slug: string,
  locale: SiteLocale,
): Promise<CategoryPage | null> {
  const rows = await loadActive(reader, locale);
  const row = rows.find((candidate) => candidate.slug === slug);
  if (row === undefined) return null;
  const page = serialize(categoryPageDto, {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    seoText: row.seo_text,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    noindex: row.noindex,
    sizeSystem: row.size_system,
    imageUrl: row.image_url,
    breadcrumbs: ancestry(rows, row.id),
  });
  const flat = rows.map((r) => ({ id: r.id, parentId: r.parent_id }));
  return { page, categoryIds: collectCategoryIds(flat, row.id) };
}

/** Breadcrumb trail (root first) for a category id, used by product pages. */
export async function getCategoryTrail(
  reader: Reader,
  categoryId: string,
  locale: SiteLocale,
): Promise<CrumbDto[]> {
  return ancestry(await loadActive(reader, locale), categoryId);
}
