'use server';

import { deleteProductImage, updateProductImage } from '@store/core/admin-images';
import {
  createProduct,
  setProductActive,
  updateProductContent,
  updateProductPricing,
} from '@store/core/admin-products';
import {
  createProductSchema,
  deleteImageSchema,
  generateVariantsSchema,
  productContentSchema,
  productPricingSchema,
  setActiveSchema,
  updateImageSchema,
  variantContentSchema,
  variantPricingSchema,
} from '@store/core/admin-schemas';
import {
  generateVariants,
  updateVariantContent,
  updateVariantPricing,
} from '@store/core/admin-variants';

import { catalogAction } from '@/lib/admin/catalog-action';
import { mediaConfig } from '@/lib/media';

/**
 * Every catalog mutation names ONE permission (docs/SECURITY.md) and goes through `catalogAction`
 * -> `adminAction`: Origin, session, permission, limit, validation, audit, then cache tags after
 * the commit. Text and price are separate actions on purpose: a role that may edit text
 * (`catalog.edit`) cannot reach a price (`catalog.price`) through the same call.
 */
export async function createProductAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.create',
    schema: createProductSchema,
    input,
    op: createProduct,
  });
}

export async function updateProductContentAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.edit',
    schema: productContentSchema,
    input,
    touchesRedirects: true,
    op: updateProductContent,
  });
}

export async function updateProductPricingAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.price',
    schema: productPricingSchema,
    input,
    op: updateProductPricing,
  });
}

export async function setProductActiveAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.publish',
    schema: setActiveSchema,
    input,
    op: setProductActive,
  });
}

export async function generateVariantsAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.edit',
    schema: generateVariantsSchema,
    input,
    op: generateVariants,
  });
}

export async function updateVariantContentAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.edit',
    schema: variantContentSchema,
    input,
    op: updateVariantContent,
  });
}

export async function updateVariantPricingAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.price',
    schema: variantPricingSchema,
    input,
    op: updateVariantPricing,
  });
}

export async function updateProductImageAction(input: unknown) {
  return await catalogAction({
    permission: 'media.upload',
    schema: updateImageSchema,
    input,
    op: updateProductImage,
  });
}

/** Deletes the row, then (after the commit) the files. A storage failure leaves orphan files, never a broken page. */
export async function deleteProductImageAction(input: unknown) {
  const result = await catalogAction({
    permission: 'media.upload',
    schema: deleteImageSchema,
    input,
    op: deleteProductImage,
  });
  if (result.ok) {
    const media = await mediaConfig();
    if (media !== null) {
      await Promise.allSettled(
        result.data.keys.map(async (key) => {
          await media.storage.remove(key);
        }),
      );
    }
  }
  return result.ok ? { ok: true as const } : result;
}
