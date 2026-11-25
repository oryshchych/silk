/**
 * Colours, sizes, attributes and their values. A change here can reach many products, so the
 * cache tags are those of the products that USE the entry (capped), never the whole catalog.
 */
import { eq, sql } from 'drizzle-orm';

import {
  attributes,
  attributeValues,
  colors,
  products,
  productAttributeValues,
  sizes,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { listingTag, productTag, SHOWCASE_TAG } from '@store/shared/cache-tags';

import { AdminNotFoundError } from './errors.ts';
import { mapUnique, type AdminOutcome } from './outcome.ts';

const TAG_CAP = 500;

async function tagsForProducts(tx: Tx, query: ReturnType<typeof sql>): Promise<string[]> {
  const rows = await tx.execute<{ id: string; category_id: string }>(query);
  return [
    SHOWCASE_TAG,
    ...new Set(rows.rows.flatMap((row) => [productTag(row.id), listingTag(row.category_id)])),
  ];
}

export async function saveColor(
  tx: Tx,
  input: {
    colorId?: string | undefined;
    slug: string;
    nameUk: string;
    nameEn: string;
    hex: string;
    sortOrder: number;
  },
): Promise<AdminOutcome<{ colorId: string }>> {
  const values = {
    slug: input.slug,
    nameUk: input.nameUk,
    nameEn: input.nameEn,
    hex: input.hex,
    sortOrder: input.sortOrder,
  };
  let colorId = input.colorId;
  if (colorId === undefined) {
    const created = await mapUnique(tx, async (inner) => {
      const [row] = await inner.insert(colors).values(values).returning({ id: colors.id });
      if (row === undefined) throw new Error('colour insert returned no row');
      return row;
    });
    colorId = created.id;
  } else {
    const updated = await mapUnique(
      tx,
      async (inner) =>
        await inner
          .update(colors)
          .set(values)
          .where(eq(colors.id, colorId ?? ''))
          .returning({ id: colors.id }),
    );
    if (updated.length === 0) throw new AdminNotFoundError('color');
  }
  return {
    data: { colorId },
    audit: {
      action: input.colorId === undefined ? 'create' : 'update',
      entity: 'color',
      entityId: colorId,
      diff: values,
    },
    tags:
      input.colorId === undefined
        ? []
        : await tagsForProducts(
            tx,
            sql`SELECT DISTINCT p.id, p.category_id FROM products p
                JOIN product_variants v ON v.product_id = p.id
                WHERE v.color_id = ${colorId}::uuid LIMIT ${TAG_CAP}`,
          ),
  };
}

export async function saveSize(
  tx: Tx,
  input: {
    sizeId?: string | undefined;
    system: 'bra' | 'panty' | 'apparel' | 'onesize';
    label: string;
    band: number | null;
    cup: string | null;
    euLabel: string | null;
    usLabel: string | null;
    sortOrder: number;
  },
): Promise<AdminOutcome<{ sizeId: string }>> {
  const { sizeId: existing, ...values } = input;
  let sizeId = existing;
  if (sizeId === undefined) {
    const created = await mapUnique(tx, async (inner) => {
      const [row] = await inner.insert(sizes).values(values).returning({ id: sizes.id });
      if (row === undefined) throw new Error('size insert returned no row');
      return row;
    });
    sizeId = created.id;
  } else {
    const updated = await mapUnique(
      tx,
      async (inner) =>
        await inner
          .update(sizes)
          .set(values)
          .where(eq(sizes.id, sizeId ?? ''))
          .returning({ id: sizes.id }),
    );
    if (updated.length === 0) throw new AdminNotFoundError('size');
  }
  return {
    data: { sizeId },
    audit: {
      action: existing === undefined ? 'create' : 'update',
      entity: 'size',
      entityId: sizeId,
      diff: values,
    },
    tags:
      existing === undefined
        ? []
        : await tagsForProducts(
            tx,
            sql`SELECT DISTINCT p.id, p.category_id FROM products p
                JOIN product_variants v ON v.product_id = p.id
                WHERE v.size_id = ${sizeId}::uuid LIMIT ${TAG_CAP}`,
          ),
  };
}

export async function saveAttribute(
  tx: Tx,
  input: {
    attributeId?: string | undefined;
    code: string;
    nameUk: string;
    nameEn: string;
    type: 'select' | 'multiselect' | 'boolean' | 'text';
    isFilterable: boolean;
    sortOrder: number;
  },
): Promise<AdminOutcome<{ attributeId: string }>> {
  const { attributeId: existing, ...values } = input;
  let attributeId = existing;
  if (attributeId === undefined) {
    const created = await mapUnique(tx, async (inner) => {
      const [row] = await inner.insert(attributes).values(values).returning({ id: attributes.id });
      if (row === undefined) throw new Error('attribute insert returned no row');
      return row;
    });
    attributeId = created.id;
  } else {
    const updated = await mapUnique(
      tx,
      async (inner) =>
        await inner
          .update(attributes)
          .set(values)
          .where(eq(attributes.id, attributeId ?? ''))
          .returning({ id: attributes.id }),
    );
    if (updated.length === 0) throw new AdminNotFoundError('attribute');
  }
  return {
    data: { attributeId },
    audit: {
      action: existing === undefined ? 'create' : 'update',
      entity: 'attribute',
      entityId: attributeId,
      diff: values,
    },
    tags: existing === undefined ? [] : [SHOWCASE_TAG],
  };
}

export async function saveAttributeValue(
  tx: Tx,
  input: {
    attributeId: string;
    valueId?: string | undefined;
    slug: string;
    valueUk: string;
    valueEn: string;
    sortOrder: number;
  },
): Promise<AdminOutcome<{ valueId: string }>> {
  const [attribute] = await tx
    .select({ id: attributes.id })
    .from(attributes)
    .where(eq(attributes.id, input.attributeId));
  if (attribute === undefined) throw new AdminNotFoundError('attribute');
  const { valueId: existing, ...values } = input;
  let valueId = existing;
  if (valueId === undefined) {
    const created = await mapUnique(tx, async (inner) => {
      const [row] = await inner
        .insert(attributeValues)
        .values(values)
        .returning({ id: attributeValues.id });
      if (row === undefined) throw new Error('attribute value insert returned no row');
      return row;
    });
    valueId = created.id;
  } else {
    const updated = await mapUnique(
      tx,
      async (inner) =>
        await inner
          .update(attributeValues)
          .set(values)
          .where(eq(attributeValues.id, valueId ?? ''))
          .returning({ id: attributeValues.id }),
    );
    if (updated.length === 0) throw new AdminNotFoundError('attribute');
  }
  return {
    data: { valueId },
    audit: {
      action: existing === undefined ? 'create' : 'update',
      entity: 'attribute_value',
      entityId: valueId,
      diff: values,
    },
    tags:
      existing === undefined
        ? []
        : await tagsForProducts(
            tx,
            sql`SELECT DISTINCT p.id, p.category_id FROM products p
                JOIN product_attribute_values pav ON pav.product_id = p.id
                WHERE pav.attribute_value_id = ${valueId}::uuid LIMIT ${TAG_CAP}`,
          ),
  };
}

/** Replaces the attribute values of a product with exactly this set. */
export async function setProductAttributes(
  tx: Tx,
  input: { productId: string; attributeValueIds: string[] },
): Promise<AdminOutcome<{ count: number }>> {
  const [product] = await tx
    .select({ id: products.id, categoryId: products.categoryId })
    .from(products)
    .where(eq(products.id, input.productId));
  if (product === undefined) throw new AdminNotFoundError('product');
  const ids = [...new Set(input.attributeValueIds)];
  if (ids.length > 0) {
    const found = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM attribute_values
          WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
    );
    if ((found.rows[0]?.n ?? 0) !== ids.length) throw new AdminNotFoundError('attribute');
  }
  await tx
    .delete(productAttributeValues)
    .where(eq(productAttributeValues.productId, input.productId));
  if (ids.length > 0) {
    await tx
      .insert(productAttributeValues)
      .values(ids.map((attributeValueId) => ({ productId: input.productId, attributeValueId })));
  }
  return {
    data: { count: ids.length },
    audit: {
      action: 'update',
      entity: 'product',
      entityId: input.productId,
      diff: { attributeValues: ids.length },
    },
    tags: [productTag(input.productId), listingTag(product.categoryId)],
  };
}
