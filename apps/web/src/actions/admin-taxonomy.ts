'use server';

import { createCategory, moveCategory, updateCategory } from '@store/core/admin-categories';
import {
  saveAttribute,
  saveAttributeValue,
  saveColor,
  saveSize,
  setProductAttributes,
} from '@store/core/admin-dictionaries';
import {
  attributeSchema,
  attributeValueSchema,
  colorSchema,
  createCategorySchema,
  moveCategorySchema,
  setProductAttributesSchema,
  sizeSchema,
  updateCategorySchema,
} from '@store/core/admin-schemas';

import { catalogAction } from '@/lib/admin/catalog-action';

/**
 * Categories, dictionaries and product attributes. One permission per action (docs/SECURITY.md):
 * categories `categories.edit`, colours/sizes/attributes `dictionaries.edit`, assigning attribute
 * values to a product `catalog.edit`.
 */
export async function setProductAttributesAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.edit',
    schema: setProductAttributesSchema,
    input,
    op: setProductAttributes,
  });
}

export async function createCategoryAction(input: unknown) {
  return await catalogAction({
    permission: 'categories.edit',
    schema: createCategorySchema,
    input,
    op: createCategory,
  });
}

export async function updateCategoryAction(input: unknown) {
  return await catalogAction({
    permission: 'categories.edit',
    schema: updateCategorySchema,
    input,
    dropped: (data) => (data.changed.includes('slug') ? { redirects: true } : {}),
    op: updateCategory,
  });
}

export async function moveCategoryAction(input: unknown) {
  return await catalogAction({
    permission: 'categories.edit',
    schema: moveCategorySchema,
    input,
    op: moveCategory,
  });
}

export async function saveColorAction(input: unknown) {
  return await catalogAction({
    permission: 'dictionaries.edit',
    schema: colorSchema,
    input,
    op: saveColor,
  });
}

export async function saveSizeAction(input: unknown) {
  return await catalogAction({
    permission: 'dictionaries.edit',
    schema: sizeSchema,
    input,
    op: saveSize,
  });
}

export async function saveAttributeAction(input: unknown) {
  return await catalogAction({
    permission: 'dictionaries.edit',
    schema: attributeSchema,
    input,
    op: saveAttribute,
  });
}

export async function saveAttributeValueAction(input: unknown) {
  return await catalogAction({
    permission: 'dictionaries.edit',
    schema: attributeValueSchema,
    input,
    op: saveAttributeValue,
  });
}
