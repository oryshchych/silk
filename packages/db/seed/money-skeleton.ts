/**
 * Minimal catalog for the phase 0.5 money skeleton: one category, one
 * product, two variants with a stock of exactly one unit each. Not the demo
 * seed: tests call this on a fresh database so every concurrency scenario
 * starts from known numbers.
 */
import { categories, colors, productVariants, products, sizes } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';

export interface MoneySkeletonFixture {
  productId: string;
  /** Two variants of the same product, `stock_quantity = 1`, price 1299.00. */
  variantIds: [string, string];
}

export const SKELETON_PRICE = 129_900;

export async function seedMoneySkeleton(tx: Tx): Promise<MoneySkeletonFixture> {
  const [category] = await tx
    .insert(categories)
    .values({ slug: 'bras', nameUk: 'Бюстгальтери', nameEn: 'Bras', sizeSystem: 'apparel' })
    .returning({ id: categories.id });
  const [color] = await tx
    .insert(colors)
    .values({ slug: 'black', nameUk: 'Чорний', nameEn: 'Black', hex: '#000000' })
    .returning({ id: colors.id });
  const sizeRows = await tx
    .insert(sizes)
    .values([
      { system: 'apparel', label: 'S', sortOrder: 1 },
      { system: 'apparel', label: 'M', sortOrder: 2 },
    ])
    .returning({ id: sizes.id });
  if (category === undefined || color === undefined || sizeRows.length !== 2) {
    throw new Error('money skeleton fixture: base rows were not inserted');
  }

  const [product] = await tx
    .insert(products)
    .values({
      sku: 'SK-001',
      slug: 'skeleton-bra',
      brand: 'Skeleton',
      categoryId: category.id,
      nameUk: 'Тестовий бюстгальтер',
      nameEn: 'Test bra',
      basePrice: SKELETON_PRICE,
      isActive: true,
    })
    .returning({ id: products.id });
  if (product === undefined) throw new Error('money skeleton fixture: product was not inserted');

  const variants = await tx
    .insert(productVariants)
    .values(
      sizeRows.map((size, index) => ({
        productId: product.id,
        sizeId: size.id,
        colorId: color.id,
        sku: `SK-001-${String(index + 1)}`,
        stockQuantity: 1,
      })),
    )
    .returning({ id: productVariants.id });
  const [first, second] = variants;
  if (first === undefined || second === undefined) {
    throw new Error('money skeleton fixture: variants were not inserted');
  }
  return { productId: product.id, variantIds: [first.id, second.id] };
}
