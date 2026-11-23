/**
 * A small, exactly known catalog for the storefront read tests: a category
 * tree with an inactive branch, products in every visibility state, and
 * variants whose stock makes the filter rules observable.
 */
import { sql } from 'drizzle-orm';

import {
  attributeValues,
  attributes,
  categories,
  colors,
  productAttributeValues,
  productImages,
  productVariants,
  products,
  sizes,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';

/** Cost price planted on every product; it must never appear in a public response. */
export const SECRET_COST = 4_242_424;

export interface CatalogFixture {
  categoryIds: Record<string, string>;
  productIds: Record<string, string>;
  variantIds: Record<string, string>;
}

type Tuple = readonly [string, string, string];

async function insertCategories(tx: Tx): Promise<Record<string, string>> {
  const spec: readonly {
    slug: string;
    parent: string | null;
    uk: string;
    en: string;
    active?: boolean;
    depth: number;
  }[] = [
    { slug: 'lingerie', parent: null, uk: 'Білизна', en: 'Lingerie', depth: 0 },
    { slug: 'bras', parent: 'lingerie', uk: 'Бюстгальтери', en: 'Bras', depth: 1 },
    { slug: 'push-up', parent: 'bras', uk: 'Пуш-ап', en: 'Push-up', depth: 2 },
    { slug: 'homewear', parent: null, uk: 'Домашній одяг', en: 'Homewear', depth: 0 },
    { slug: 'archive', parent: null, uk: 'Архів', en: 'Archive', active: false, depth: 0 },
    { slug: 'archive-old', parent: 'archive', uk: 'Старе', en: 'Old', depth: 1 },
  ];
  const ids: Record<string, string> = {};
  for (const [index, c] of spec.entries()) {
    const [row] = await tx
      .insert(categories)
      .values({
        slug: c.slug,
        parentId: c.parent === null ? null : (ids[c.parent] ?? null),
        nameUk: c.uk,
        nameEn: c.en,
        depth: c.depth,
        sortOrder: index,
        isActive: c.active ?? true,
        sizeSystem: c.slug === 'homewear' ? 'apparel' : 'bra',
      })
      .returning({ id: categories.id });
    if (row === undefined) throw new Error('category');
    ids[c.slug] = row.id;
  }
  return ids;
}

export async function seedCatalogFixture(tx: Tx): Promise<CatalogFixture> {
  const categoryIds = await insertCategories(tx);

  const colorSpec: readonly Tuple[] = [
    ['black', 'Чорний', 'Black'],
    ['white', 'Білий', 'White'],
    ['nude', 'Тілесний', 'Nude'],
  ];
  const colorRows = await tx
    .insert(colors)
    .values(
      colorSpec.map(([slug, uk, en], i) => ({
        slug,
        nameUk: uk,
        nameEn: en,
        hex: '#101010',
        sortOrder: i,
      })),
    )
    .returning({ id: colors.id, slug: colors.slug });
  const color = (slug: string): string => colorRows.find((c) => c.slug === slug)?.id ?? '';

  const braSizes = [
    [70, 'A'],
    [75, 'A'],
    [75, 'B'],
    [75, 'C'],
    [80, 'B'],
  ] as const;
  const sizeRows = await tx
    .insert(sizes)
    .values([
      ...braSizes.map(([band, cup], i) => ({
        system: 'bra' as const,
        label: `${String(band)}${cup}`,
        band,
        cup,
        sortOrder: i,
      })),
      { system: 'apparel' as const, label: 'S', sortOrder: 0 },
      { system: 'apparel' as const, label: 'M', sortOrder: 1 },
    ])
    .returning({ id: sizes.id, label: sizes.label });
  const size = (label: string): string => sizeRows.find((s) => s.label === label)?.id ?? '';

  const productIds: Record<string, string> = {};
  const variantIds: Record<string, string> = {};

  async function product(
    key: string,
    v: {
      category: string;
      brand: string;
      nameUk: string;
      nameEn: string;
      price: number;
      compareAt?: number;
      daysAgo?: number | null;
      active?: boolean;
      kind?: 'physical' | 'gift_card';
      badge?: 'bestseller';
      variants: readonly (readonly [string, string, number])[];
    },
  ): Promise<void> {
    const [row] = await tx
      .insert(products)
      .values({
        sku: `SKU-${key}`,
        slug: key,
        brand: v.brand,
        kind: v.kind ?? 'physical',
        categoryId: categoryIds[v.category] ?? '',
        nameUk: v.nameUk,
        nameEn: v.nameEn,
        shortDescriptionUk: `${v.nameUk}: короткий опис`,
        shortDescriptionEn: `${v.nameEn}: short description`,
        basePrice: v.price,
        compareAtPrice: v.compareAt ?? null,
        costPrice: SECRET_COST,
        weightGrams: v.kind === 'gift_card' ? 0 : 200,
        isActive: v.active ?? true,
        badge: v.badge ?? 'none',
        publishedAt:
          v.daysAgo === null ? null : sql`now() - make_interval(days => ${v.daysAgo ?? 1})`,
      })
      .returning({ id: products.id });
    if (row === undefined) throw new Error('product');
    productIds[key] = row.id;
    for (const [sizeLabel, colorSlug, stock] of v.variants) {
      const [variant] = await tx
        .insert(productVariants)
        .values({
          productId: row.id,
          sizeId: size(sizeLabel),
          colorId: color(colorSlug),
          sku: `${key}-${sizeLabel}-${colorSlug}`,
          stockQuantity: stock,
        })
        .returning({ id: productVariants.id });
      if (variant === undefined) throw new Error('variant');
      variantIds[`${key}:${sizeLabel}:${colorSlug}`] = variant.id;
    }
  }

  await product('aurora', {
    category: 'bras',
    brand: 'Aurelia',
    nameUk: 'Бюстгальтер «Аврора»',
    nameEn: 'Bra "Aurora"',
    price: 129_900,
    compareAt: 159_900,
    daysAgo: 1,
    variants: [
      ['75B', 'black', 5],
      ['75B', 'white', 0],
      ['80B', 'black', 2],
    ],
  });
  await product('lavanda', {
    category: 'push-up',
    brand: 'Aurelia',
    nameUk: 'Бюстгальтер пуш-ап «Лаванда»',
    nameEn: 'Push-up bra "Lavender"',
    badge: 'bestseller',
    price: 99_900,
    daysAgo: 2,
    variants: [
      ['75B', 'white', 4],
      ['75C', 'black', 3],
    ],
  });
  await product('breeze', {
    category: 'bras',
    brand: 'Nord Lace',
    nameUk: 'Бюстгальтер «Бриз»',
    nameEn: 'Bra "Breeze"',
    price: 59_900,
    daysAgo: 3,
    variants: [['70A', 'nude', 0]],
  });
  await product('robe', {
    category: 'homewear',
    brand: 'Mila Home',
    nameUk: 'Жіночий халат «Магнолія»',
    nameEn: 'Women robe "Magnolia"',
    price: 89_900,
    daysAgo: 4,
    variants: [
      ['M', 'black', 5],
      ['S', 'black', 5],
    ],
  });
  await product('draft', {
    category: 'bras',
    brand: 'Aurelia',
    nameUk: 'Чернетка бюстгальтер',
    nameEn: 'Draft bra',
    price: 10_000,
    active: false,
    variants: [['75B', 'black', 5]],
  });
  await product('unpublished', {
    category: 'bras',
    brand: 'Aurelia',
    nameUk: 'Неопублікований бюстгальтер',
    nameEn: 'Unpublished bra',
    price: 10_000,
    daysAgo: null,
    variants: [['75B', 'black', 5]],
  });
  await product('future', {
    category: 'bras',
    brand: 'Aurelia',
    nameUk: 'Майбутній бюстгальтер',
    nameEn: 'Future bra',
    price: 10_000,
    daysAgo: -5,
    variants: [['75B', 'black', 5]],
  });
  await product('giftcard', {
    category: 'bras',
    brand: 'Aurelia',
    nameUk: 'Сертифікат бюстгальтер',
    nameEn: 'Gift card bra',
    price: 10_000,
    kind: 'gift_card',
    variants: [['75B', 'black', 5]],
  });
  // Active and published, but its OWN category is inactive: only the c0 check of the
  // ancestor chain hides it (the product above sits in an active child of an inactive parent).
  await product('shelved', {
    category: 'archive',
    brand: 'Aurelia',
    nameUk: 'Знятий бюстгальтер',
    nameEn: 'Shelved bra',
    price: 10_000,
    variants: [['75B', 'black', 5]],
  });
  await product('archived', {
    category: 'archive-old',
    brand: 'Aurelia',
    nameUk: 'Архівний бюстгальтер',
    nameEn: 'Archived bra',
    price: 10_000,
    variants: [['75B', 'black', 5]],
  });

  const aurora = productIds['aurora'] ?? '';
  await tx.insert(productImages).values([
    {
      productId: aurora,
      url: 'https://cdn.example/aurora-2.webp',
      sortOrder: 2,
      width: 800,
      height: 1000,
    },
    {
      productId: aurora,
      url: 'https://cdn.example/aurora-1.webp',
      altUk: 'Аврора спереду',
      altEn: 'Aurora front',
      sortOrder: 1,
      width: 800,
      height: 1000,
    },
    {
      productId: aurora,
      colorId: color('black'),
      url: 'https://cdn.example/aurora-black.webp',
      sortOrder: 3,
    },
  ]);

  const [attribute] = await tx
    .insert(attributes)
    .values({ code: 'cup_type', nameUk: 'Тип чашки', nameEn: 'Cup type' })
    .returning({ id: attributes.id });
  const [value] = await tx
    .insert(attributeValues)
    .values({
      attributeId: attribute?.id ?? '',
      slug: 'padded',
      valueUk: 'З поролоном',
      valueEn: 'Padded',
    })
    .returning({ id: attributeValues.id });
  await tx
    .insert(productAttributeValues)
    .values({ productId: aurora, attributeValueId: value?.id ?? '' });

  return { categoryIds, productIds, variantIds };
}
