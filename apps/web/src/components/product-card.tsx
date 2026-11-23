import { getTranslations } from 'next-intl/server';
import Image from 'next/image';
import Link from 'next/link';

import { formatMoney } from '@store/shared/money';
import type { ProductCardDto } from '@store/shared/dto/catalog';
import type { SiteLocale } from '@store/shared/seo';

import { href, paths } from '@/lib/paths';

const IMAGE_SIZES = '(min-width: 1024px) 25vw, 50vw';

const BADGE_KEYS = {
  new: 'badgeNew',
  sale: 'badgeSale',
  bestseller: 'badgeBestseller',
  last_units: 'badgeLastUnits',
} as const;

export async function ProductCard({
  product,
  locale,
  priority = false,
}: {
  product: ProductCardDto;
  locale: SiteLocale;
  priority?: boolean;
}) {
  const t = await getTranslations('card');
  const badge = product.badge === 'none' ? null : t(BADGE_KEYS[product.badge]);
  return (
    <article className="group flex flex-col gap-2">
      <Link
        href={href(locale, paths.product(product.slug))}
        className="flex flex-col gap-2 rounded-sm"
      >
        <div className="relative aspect-[4/5] overflow-hidden rounded-sm bg-surface-raised">
          {product.image === null ? (
            <span className="flex h-full items-center justify-center text-sm text-text-muted">
              {t('noImage')}
            </span>
          ) : (
            <Image
              src={product.image.url}
              alt={product.image.alt}
              width={product.image.width ?? 800}
              height={product.image.height ?? 1000}
              sizes={IMAGE_SIZES}
              priority={priority}
              unoptimized
              className="h-full w-full object-cover"
            />
          )}
          {badge === null ? null : (
            <span className="absolute left-2 top-2 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-contrast">
              {badge}
            </span>
          )}
        </div>
        <h3 className="text-sm">{product.name}</h3>
      </Link>
      <p className="text-xs text-text-muted">{product.brand}</p>
      <p className="flex items-baseline gap-2 text-sm">
        <span>{formatMoney(product.price, locale)}</span>
        {product.compareAtPrice === null ? null : (
          <s className="text-text-muted">{formatMoney(product.compareAtPrice, locale)}</s>
        )}
      </p>
      {product.inStock ? null : <p className="text-xs text-text-muted">{t('outOfStock')}</p>}
    </article>
  );
}
