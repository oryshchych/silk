'use server';

import {
  createProduct,
  setProductActive,
  updateProductContent,
  updateProductPricing,
} from '@store/core/admin-products';
import {
  createProductSchema,
  generateVariantsSchema,
  productContentSchema,
  productPricingSchema,
  setActiveSchema,
  variantContentSchema,
  variantPricingSchema,
} from '@store/core/admin-schemas';
import {
  generateVariants,
  updateVariantContent,
  updateVariantPricing,
} from '@store/core/admin-variants';

import { catalogAction } from '@/lib/admin/catalog-action';

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
