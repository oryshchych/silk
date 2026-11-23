import type { ProductImageDto, VariantDto } from '@store/shared/dto/catalog';
import type { OfferInput } from '@store/shared/schema-org';

import { imagesForColor } from './variant-selection';

/**
 * Absolute image URLs for structured data: the photos of the colour the page
 * opens on first (they are the product's face), then the rest, each once.
 * Site-relative paths are made absolute against the runtime site URL.
 */
export function productImageUrls(
  images: readonly ProductImageDto[],
  colorSlug: string,
  siteUrl: string,
): string[] {
  const first = imagesForColor(images, colorSlug);
  const ordered = [...first, ...images.filter((image) => !first.includes(image))];
  const urls = ordered.map((image) =>
    image.url.startsWith('/') ? `${siteUrl}${image.url}` : image.url,
  );
  return [...new Set(urls)];
}

/** One offer per distinct (price, availability) pair, not one per size and colour. */
export function uniqueOffers(
  variants: readonly Pick<VariantDto, 'price' | 'available'>[],
  url: string,
): OfferInput[] {
  const seen = new Set<string>();
  const offers: OfferInput[] = [];
  for (const variant of variants) {
    const key = `${String(variant.price)}:${String(variant.available)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({
      price: variant.price,
      availability: variant.available ? 'InStock' : 'OutOfStock',
      url,
    });
  }
  return offers;
}
