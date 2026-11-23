/**
 * Colour and size selection on the product page, as pure functions: an
 * unavailable size can never become the selection, and changing colour keeps
 * the size only when that size is available in the new colour.
 */
import type { ProductImageDto, VariantDto } from '@store/shared/dto/catalog';

/** A variant as the browser needs it: the price stays on the server (it is formatted there). */
export type SelectableVariant = Omit<VariantDto, 'price'>;

export interface Selection {
  colorSlug: string;
  /** Selected variant (one size in the selected colour), or null. */
  variantId: string | null;
}

/** Starts on the first colour that has anything to buy, else on the first colour. */
export function initialSelection(variants: readonly SelectableVariant[]): Selection {
  const preferred = variants.find((variant) => variant.available) ?? variants[0];
  return { colorSlug: preferred?.colorSlug ?? '', variantId: null };
}

export const variantsOfColor = (
  variants: readonly SelectableVariant[],
  colorSlug: string,
): SelectableVariant[] => variants.filter((variant) => variant.colorSlug === colorSlug);

export function selectVariant(
  state: Selection,
  variants: readonly SelectableVariant[],
  variantId: string,
): Selection {
  const variant = variants.find((candidate) => candidate.id === variantId);
  if (variant === undefined || variant.colorSlug !== state.colorSlug || !variant.available) {
    return state;
  }
  return { ...state, variantId: variant.id };
}

export function selectColor(
  state: Selection,
  variants: readonly SelectableVariant[],
  colorSlug: string,
): Selection {
  if (!variants.some((variant) => variant.colorSlug === colorSlug)) return state;
  const current = variants.find((variant) => variant.id === state.variantId);
  const sameSize = variants.find(
    (variant) =>
      variant.colorSlug === colorSlug &&
      variant.sizeLabel === current?.sizeLabel &&
      variant.available,
  );
  return { colorSlug, variantId: sameSize?.id ?? null };
}

/** Photos of the selected colour plus the colour-less ones; all photos if the colour has none. */
export function imagesForColor(
  images: readonly ProductImageDto[],
  colorSlug: string,
): ProductImageDto[] {
  const matching = images.filter(
    (image) => image.colorSlug === colorSlug || image.colorSlug === null,
  );
  return matching.length > 0 ? matching : [...images];
}
