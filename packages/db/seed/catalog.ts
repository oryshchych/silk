/**
 * Каталог: категорії, кольори, розміри, ~40 товарів із варіантами й
 * залишками. Бренди вигадані — реальних назв у тестових даних немає.
 */
import { sql } from 'drizzle-orm';

import { categories, colors, products, productVariants, sizes } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';
import type { Rng } from './random.ts';

type SizeSystem = 'bra' | 'panty' | 'apparel' | 'onesize';

/** Варіант, з якого seed будує позиції замовлень. */
export interface SeedVariant {
  id: string;
  productId: string;
  sku: string;
  productSku: string;
  nameUk: string;
  brand: string;
  sizeLabel: string;
  sizeSystem: SizeSystem;
  colorNameUk: string;
  categoryPath: string;
  categorySlug: string;
  /** Товар зі знижкою (compare_at_price) — для правила excludes_discounted_items. */
  onSale: boolean;
  unitPrice: number;
  unitCost: number | null;
  stock: number;
  isActive: boolean;
}

export interface SeedCatalog {
  variants: SeedVariant[];
  categoryIds: Record<string, string>;
  productIds: string[];
}

const BRANDS = ['Aurelia', 'Nord Lace', 'Velvet Line', 'Mila Home', 'Soft Cotton Co'] as const;

const COLLECTIONS = [
  ['Аврора', 'Aurora', 'aurora'],
  ['Лаванда', 'Lavender', 'lavender'],
  ['Мрія', 'Dream', 'dream'],
  ['Вероніка', 'Veronica', 'veronica'],
  ['Сакура', 'Sakura', 'sakura'],
  ['Опал', 'Opal', 'opal'],
  ['Бриз', 'Breeze', 'breeze'],
  ['Ґардена', 'Gardena', 'gardena'],
  ['Єва', 'Eva', 'eva'],
  ['Ірис', 'Iris', 'iris'],
  ['Магнолія', 'Magnolia', 'magnolia'],
  ['Скарлет', 'Scarlet', 'scarlet'],
] as const;

const COLORS = [
  ['black', 'Чорний', 'Black', '#1A1A1A'],
  ['white', 'Білий', 'White', '#F7F5F0'],
  ['nude', 'Тілесний', 'Nude', '#D9B8A0'],
  ['powder', 'Пудровий', 'Powder rose', '#E8C4C4'],
  ['burgundy', 'Бордовий', 'Burgundy', '#6D1A2B'],
  ['navy', 'Темно-синій', 'Navy', '#1F2A44'],
  ['emerald', 'Смарагдовий', 'Emerald', '#1F5E4A'],
  ['grey', 'Сірий меланж', 'Heather grey', '#9A9A9A'],
] as const;

const BRA_US_BAND: Record<number, number> = { 70: 32, 75: 34, 80: 36, 85: 38 };
const APPAREL_LABELS = ['XS', 'S', 'M', 'L', 'XL'] as const;

interface CategorySpec {
  slug: string;
  parent: string | null;
  uk: string;
  en: string;
  system: SizeSystem | null;
}

const CATEGORY_SPECS: CategorySpec[] = [
  { slug: 'lingerie', parent: null, uk: 'Білизна', en: 'Lingerie', system: null },
  { slug: 'bras', parent: 'lingerie', uk: 'Бюстгальтери', en: 'Bras', system: 'bra' },
  { slug: 'panties', parent: 'lingerie', uk: 'Трусики', en: 'Panties', system: 'panty' },
  { slug: 'sets', parent: 'lingerie', uk: 'Комплекти', en: 'Lingerie sets', system: 'bra' },
  { slug: 'homewear', parent: null, uk: 'Домашній одяг', en: 'Homewear', system: null },
  { slug: 'pyjamas', parent: 'homewear', uk: 'Піжами', en: 'Pyjamas', system: 'apparel' },
  { slug: 'robes', parent: 'homewear', uk: 'Халати', en: 'Robes', system: 'apparel' },
  {
    slug: 'lounge',
    parent: 'homewear',
    uk: 'Домашні костюми',
    en: 'Lounge sets',
    system: 'apparel',
  },
];

interface ProductSpec {
  category: string;
  count: number;
  /** [uk, en, slug] */
  types: readonly (readonly [string, string, string])[];
  /** Ціна в гривнях: lo..hi сотень, завжди «…99». */
  priceHundreds: readonly [number, number];
  weightGrams: number;
  composition: readonly [string, string];
}

const PRODUCT_SPECS: ProductSpec[] = [
  {
    category: 'bras',
    count: 10,
    types: [
      ['Бюстгальтер пуш-ап', 'Push-up bra', 'push-up-bra'],
      ['Бюстгальтер балконет', 'Balconette bra', 'balconette-bra'],
      ['Бралет', 'Bralette', 'bralette'],
      ['Бюстгальтер без кісточок', 'Wireless bra', 'wireless-bra'],
      ['Мереживний бюстгальтер', 'Lace bra', 'lace-bra'],
    ],
    priceHundreds: [8, 18],
    weightGrams: 120,
    composition: ['Поліамід 85%, еластан 15%', 'Polyamide 85%, elastane 15%'],
  },
  {
    category: 'panties',
    count: 8,
    types: [
      ['Трусики сліп', 'Briefs', 'briefs'],
      ['Трусики бразиліана', 'Brazilian briefs', 'brazilian-briefs'],
      ['Стрінги', 'Thong', 'thong'],
      ['Мереживні трусики', 'Lace briefs', 'lace-briefs'],
    ],
    priceHundreds: [2, 5],
    weightGrams: 40,
    composition: ['Бавовна 92%, еластан 8%', 'Cotton 92%, elastane 8%'],
  },
  {
    category: 'sets',
    count: 6,
    types: [
      ['Комплект білизни', 'Lingerie set', 'lingerie-set'],
      ['Мереживний комплект', 'Lace lingerie set', 'lace-lingerie-set'],
    ],
    priceHundreds: [14, 28],
    weightGrams: 180,
    composition: ['Поліамід 80%, еластан 20%', 'Polyamide 80%, elastane 20%'],
  },
  {
    category: 'pyjamas',
    count: 6,
    types: [
      ['Піжама з шортами', 'Shorts pyjama set', 'shorts-pyjama'],
      ['Піжама зі штанами', 'Long pyjama set', 'long-pyjama'],
      ['Сатинова піжама', 'Satin pyjama set', 'satin-pyjama'],
    ],
    priceHundreds: [12, 24],
    weightGrams: 400,
    composition: ['Віскоза 95%, еластан 5%', 'Viscose 95%, elastane 5%'],
  },
  {
    category: 'robes',
    count: 5,
    types: [
      ['Халат', 'Robe', 'robe'],
      ['Сатиновий халат', 'Satin robe', 'satin-robe'],
      ['Махровий халат', 'Terry robe', 'terry-robe'],
    ],
    priceHundreds: [15, 29],
    weightGrams: 600,
    composition: ['Бавовна 100%', 'Cotton 100%'],
  },
  {
    category: 'lounge',
    count: 5,
    types: [
      ['Домашній костюм', 'Lounge set', 'lounge-set'],
      ['Трикотажний костюм', 'Knit lounge set', 'knit-lounge-set'],
    ],
    priceHundreds: [13, 26],
    weightGrams: 500,
    composition: ['Бавовна 70%, модал 30%', 'Cotton 70%, modal 30%'],
  },
];

/** Скільки товарів наприкінці лишаються чернетками (`is_active = false`). */
const DRAFTS = 2;

const hryvnias = (rng: Rng, [lo, hi]: readonly [number, number]): number =>
  (rng.int(lo, hi) * 100 + 99) * 100;

export async function seedCatalog(tx: Tx, rng: Rng): Promise<SeedCatalog> {
  const categoryIds: Record<string, string> = {};
  const nameByCategory: Record<string, string> = {};
  for (const [i, spec] of CATEGORY_SPECS.entries()) {
    const parentId = spec.parent === null ? null : (categoryIds[spec.parent] ?? null);
    const [row] = await tx
      .insert(categories)
      .values({
        slug: spec.slug,
        parentId,
        nameUk: spec.uk,
        nameEn: spec.en,
        descriptionUk: `${spec.uk} від перевірених брендів. Лише оригінальна продукція.`,
        descriptionEn: `${spec.en} from trusted brands. Original products only.`,
        seoTextUk: `<p>${spec.uk} з доставкою Новою Поштою по всій Україні. Допоможемо з розміром.</p>`,
        seoTextEn: `<p>${spec.en} delivered by Nova Poshta across Ukraine. We will help you with sizing.</p>`,
        metaTitleUk: `${spec.uk} — купити в інтернет-магазині`,
        metaTitleEn: `${spec.en} — online store`,
        sizeSystem: spec.system,
        depth: spec.parent === null ? 0 : 1,
        sortOrder: i,
      })
      .returning({ id: categories.id });
    if (row === undefined) throw new Error(`категорія ${spec.slug} не створилась`);
    categoryIds[spec.slug] = row.id;
    const parentName = spec.parent === null ? undefined : nameByCategory[spec.parent];
    nameByCategory[spec.slug] = parentName === undefined ? spec.uk : `${parentName} / ${spec.uk}`;
  }

  const colorRows = await tx
    .insert(colors)
    .values(
      COLORS.map(([slug, uk, en, hex], i) => ({ slug, nameUk: uk, nameEn: en, hex, sortOrder: i })),
    )
    .returning({ id: colors.id, slug: colors.slug, nameUk: colors.nameUk });

  const sizeRows = await tx
    .insert(sizes)
    .values([
      ...[70, 75, 80, 85].flatMap((band, b) =>
        ['A', 'B', 'C', 'D'].map((cup, c) => ({
          system: 'bra' as const,
          label: `${String(band)}${cup}`,
          band,
          cup,
          euLabel: `${String(band)}${cup}`,
          usLabel: `${String(BRA_US_BAND[band] ?? band)}${cup}`,
          sortOrder: b * 4 + c,
        })),
      ),
      ...APPAREL_LABELS.map((label, i) => ({ system: 'panty' as const, label, sortOrder: i })),
      ...APPAREL_LABELS.map((label, i) => ({ system: 'apparel' as const, label, sortOrder: i })),
      { system: 'onesize' as const, label: 'One size', sortOrder: 0 },
    ])
    .returning({ id: sizes.id, system: sizes.system, label: sizes.label });

  const variants: SeedVariant[] = [];
  const productIds: string[] = [];
  const total = PRODUCT_SPECS.reduce((n, s) => n + s.count, 0);
  let index = 0;

  for (const spec of PRODUCT_SPECS) {
    const categoryId = categoryIds[spec.category];
    const categorySpec = CATEGORY_SPECS.find((c) => c.slug === spec.category);
    const system = categorySpec?.system;
    if (categoryId === undefined || system === undefined || system === null) {
      throw new Error(`немає категорії ${spec.category}`);
    }
    const systemSizes = sizeRows.filter((s) => s.system === system);

    for (let i = 0; i < spec.count; i++, index++) {
      const type = spec.types[i % spec.types.length];
      const collection = COLLECTIONS[(i + index) % COLLECTIONS.length];
      if (type === undefined || collection === undefined) throw new Error('специфікація товару');
      const [typeUk, typeEn, typeSlug] = type;
      const [collUk, collEn, collSlug] = collection;

      const basePrice = hryvnias(rng, spec.priceHundreds);
      const costPrice = Math.round((basePrice * rng.int(40, 55)) / 100);
      const onSale = rng.chance(0.25);
      const isDraft = index >= total - DRAFTS;
      const sku = `LS-${spec.category.slice(0, 3).toUpperCase()}-${String(index + 1).padStart(3, '0')}`;
      const nameUk = `${typeUk} «${collUk}»`;
      const brand = BRANDS[index % BRANDS.length] ?? 'Aurelia';

      const [product] = await tx
        .insert(products)
        .values({
          sku,
          slug: `${typeSlug}-${collSlug}-${String(index + 1)}`,
          brand,
          categoryId,
          nameUk,
          nameEn: `${typeEn} "${collEn}"`,
          shortDescriptionUk: `${typeUk} з колекції «${collUk}» від ${brand}.`,
          shortDescriptionEn: `${typeEn} from the ${collEn} collection by ${brand}.`,
          descriptionUk: `<p>${nameUk} — м'яка посадка й делікатні матеріали на кожен день.</p>`,
          descriptionEn: `<p>${typeEn} "${collEn}" — a soft fit and delicate fabrics for every day.</p>`,
          compositionUk: spec.composition[0],
          compositionEn: spec.composition[1],
          careUk: 'Делікатне прання при 30 °C, не відбілювати, сушити горизонтально.',
          careEn: 'Delicate wash at 30 °C, do not bleach, dry flat.',
          basePrice,
          compareAtPrice: onSale ? basePrice + rng.int(2, 6) * 10000 : null,
          costPrice,
          weightGrams: spec.weightGrams,
          isActive: !isDraft,
          isFeatured: index % 7 === 0,
          badge: onSale ? 'sale' : index % 9 === 0 ? 'bestseller' : 'none',
          publishedAt: isDraft ? null : sql`now() - make_interval(days => ${index})`,
        })
        .returning({ id: products.id });
      if (product === undefined) throw new Error(`товар ${sku} не створився`);
      productIds.push(product.id);

      const productColors = rng.sample(colorRows, rng.int(2, 3));
      const productSizes = rng.sample(
        systemSizes,
        Math.min(systemSizes.length, system === 'bra' ? 6 : 4),
      );
      const variantRows = productColors.flatMap((color) =>
        productSizes.map((size) => ({
          productId: product.id,
          sizeId: size.id,
          colorId: color.id,
          sku: `${sku}-${color.slug.toUpperCase()}-${size.label.replace(' ', '')}`,
          // Частина варіантів без залишку — щоб на PLP був «немає в наявності».
          stockQuantity: rng.chance(0.15) ? 0 : rng.int(1, 8),
          colorNameUk: color.nameUk,
          sizeLabel: size.label,
        })),
      );

      const inserted = await tx
        .insert(productVariants)
        .values(
          variantRows.map((v) => ({
            productId: v.productId,
            sizeId: v.sizeId,
            colorId: v.colorId,
            sku: v.sku,
            stockQuantity: v.stockQuantity,
          })),
        )
        .returning({ id: productVariants.id, sku: productVariants.sku });

      for (const [vi, row] of inserted.entries()) {
        const v = variantRows[vi];
        if (v === undefined) throw new Error('варіант без специфікації');
        variants.push({
          id: row.id,
          productId: product.id,
          sku: row.sku,
          productSku: sku,
          nameUk,
          brand,
          sizeLabel: v.sizeLabel,
          sizeSystem: system,
          colorNameUk: v.colorNameUk,
          categoryPath: nameByCategory[spec.category] ?? spec.category,
          categorySlug: spec.category,
          onSale,
          unitPrice: basePrice,
          unitCost: costPrice,
          stock: v.stockQuantity,
          isActive: !isDraft,
        });
      }
    }
  }

  return { variants, categoryIds, productIds };
}
