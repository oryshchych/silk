import type { ProductCardDto } from '@store/shared/dto/catalog';
import type { SiteLocale } from '@store/shared/seo';

import { LISTING_CARD_SIZES } from '@/lib/image-sizes';

import { ProductCard } from './product-card';

/** A titled row of product cards on the home page. Renders nothing when there is nothing to show. */
export function ShowcaseSection({
  id,
  title,
  items,
  locale,
}: {
  id: string;
  title: string;
  items: ProductCardDto[];
  locale: SiteLocale;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className="py-6">
      <h2 id={id} className="mb-4 font-display text-2xl">
        {title}
      </h2>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.id}>
            <ProductCard product={item} locale={locale} sizes={LISTING_CARD_SIZES} as="h3" />
          </li>
        ))}
      </ul>
    </section>
  );
}
