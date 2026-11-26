'use server';

import { createCategory, moveCategory, updateCategory } from '@store/core/admin-categories';
import { categoryTextToHtml } from '@store/core/admin-category-text';
import { DomainError } from '@store/core/errors';
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
  updateCategoryContentSchema,
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

/** Thrown when a category text is too long or too deeply nested for the sanitiser. */
class CategoryTextError extends DomainError {
  constructor() {
    super('ADMIN_CATEGORY_TEXT_INVALID', 'The category text is too long or too deeply nested');
  }
}

/** The texts of a category, from its content editor. The SEO texts go through `categoryTextToHtml`. */
export async function updateCategoryContentAction(input: unknown) {
  return await catalogAction({
    permission: 'categories.edit',
    schema: updateCategoryContentSchema,
    input,
    op: async (tx, value) => {
      let seoTextUk: string;
      let seoTextEn: string;
      try {
        seoTextUk = categoryTextToHtml(value.seoTextUk);
        seoTextEn = categoryTextToHtml(value.seoTextEn);
      } catch (error) {
        if (error instanceof RangeError) throw new CategoryTextError();
        throw error;
      }
      return await updateCategory(tx, {
        ...value,
        // An empty text is NULL, not an empty string: "no text" has one spelling.
        seoTextUk: seoTextUk === '' ? null : seoTextUk,
        seoTextEn: seoTextEn === '' ? null : seoTextEn,
      });
    },
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
