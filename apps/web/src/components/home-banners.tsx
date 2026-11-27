/**
 * The home banners. Each is ONE `<picture>`: the mobile pictures under `(max-width: 767px)`, the desktop ones
 * otherwise, AVIF then WebP then the stored original. EVERY `<source>` carries the `width` and `height` of ITS OWN
 * picture (mobile on the mobile sources, desktop on the rest), so the browser reserves the box of the picture it
 * actually picks and nothing shifts on a phone; the `<img>` carries the desktop size. The first banner is the LCP
 * candidate and the rest are lazy; the title is a paragraph, never a heading above the page's `<h1>`. Plain server markup, the same for every visitor.
 * The link is a path on this shop (the database refuses anything else); the text is escaped by React.
 */
import Link from 'next/link';

import type { PublicBannerDto } from '@store/shared/dto/banner';
import type { SiteLocale } from '@store/shared/seo';

import { href as localeHref } from '../lib/paths';
import { renditionSources } from '../lib/renditions';

const MOBILE_QUERY = '(max-width: 767px)';

function Picture({ banner, first }: { banner: PublicBannerDto; first: boolean }) {
  const desktop = renditionSources(banner.desktop.url, banner.desktop.width, banner.desktop.height);
  const mobile = renditionSources(banner.mobile.url, banner.mobile.width, banner.mobile.height);
  return (
    <picture>
      {mobile === null ? null : (
        <>
          <source
            media={MOBILE_QUERY}
            type="image/avif"
            srcSet={mobile.avif}
            sizes="100vw"
            width={banner.mobile.width}
            height={banner.mobile.height}
          />
          <source
            media={MOBILE_QUERY}
            type="image/webp"
            srcSet={mobile.webp}
            sizes="100vw"
            width={banner.mobile.width}
            height={banner.mobile.height}
          />
        </>
      )}
      {mobile !== null || banner.mobile.url === banner.desktop.url ? null : (
        <source
          media={MOBILE_QUERY}
          srcSet={banner.mobile.url}
          width={banner.mobile.width}
          height={banner.mobile.height}
        />
      )}
      {desktop === null ? null : (
        <>
          <source
            type="image/avif"
            srcSet={desktop.avif}
            sizes="100vw"
            width={banner.desktop.width}
            height={banner.desktop.height}
          />
          <source
            type="image/webp"
            srcSet={desktop.webp}
            sizes="100vw"
            width={banner.desktop.width}
            height={banner.desktop.height}
          />
        </>
      )}
      <img
        src={banner.desktop.url}
        alt={banner.alt}
        width={banner.desktop.width}
        height={banner.desktop.height}
        loading={first ? 'eager' : 'lazy'}
        decoding="async"
        {...(first ? { fetchPriority: 'high' as const } : {})}
        className="h-auto w-full"
      />
    </picture>
  );
}

export function HomeBanners({
  banners,
  locale,
  label,
}: {
  banners: readonly PublicBannerDto[];
  locale: SiteLocale;
  label: string;
}) {
  if (banners.length === 0) return null;
  return (
    <section aria-label={label} className="flex flex-col gap-4 py-4">
      {banners.map((banner, index) => {
        const inner = (
          <>
            <Picture banner={banner} first={index === 0} />
            {banner.title === null &&
            banner.subtitle === null &&
            banner.ctaLabel === null ? null : (
              <div className="p-3">
                {banner.title === null ? null : (
                  <p className="font-display text-2xl">{banner.title}</p>
                )}
                {banner.subtitle === null ? null : (
                  <p className="text-text-muted">{banner.subtitle}</p>
                )}
                {banner.ctaLabel === null || banner.href === null ? null : (
                  <span className="mt-2 inline-flex min-h-11 items-center rounded-full bg-accent px-6 text-accent-contrast">
                    {banner.ctaLabel}
                  </span>
                )}
              </div>
            )}
          </>
        );
        return banner.href === null ? (
          <div key={banner.id} className="overflow-hidden rounded-sm">
            {inner}
          </div>
        ) : (
          <Link
            key={banner.id}
            href={localeHref(locale, banner.href)}
            className="block overflow-hidden rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {inner}
          </Link>
        );
      })}
    </section>
  );
}
