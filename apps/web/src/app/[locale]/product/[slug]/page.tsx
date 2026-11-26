import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { preload } from 'react-dom';
import { notFound } from 'next/navigation';

import { formatMoney } from '@store/shared/money';
import { buildBreadcrumbList, buildProduct } from '@store/shared/schema-org';
import { buildAlternates } from '@store/shared/seo';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { JsonLd } from '@/components/json-ld';
import { ProductBuyBox } from '@/components/product-buy-box';
import { TrackEvent } from '@/components/track-event';
import { SiteShell } from '@/components/site-shell';
import { SizeGuide } from '@/components/size-guide';
import { resolveLocale } from '@/i18n/locale';
import { productItem, variantItems } from '@/lib/analytics/items';
import { loadProduct } from '@/lib/catalog';
import { GALLERY_SIZES } from '@/lib/image-sizes';
import { htmlToParagraphs, htmlToSnippet } from '@/lib/html-text';
import { pageMetadata } from '@/lib/metadata';
import { productImageUrls, uniqueOffers } from '@/lib/product-jsonld';
import { renditionSources } from '@/lib/renditions';
import { imagesForColor, initialSelection } from '@/lib/variant-selection';
import { href, paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/product/[slug]'>;

const DESCRIPTION_LENGTH = 160;

// ISR: see the home page. The empty list prerenders nothing at build and makes
// the dynamic route cacheable; `product:{id}` / `category:{id}` tags refresh it.
export const revalidate = 3600;

export function generateStaticParams(): { locale: string; slug: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  const product = known ? await loadProduct(slug, locale) : null;
  if (product === null) return {};

  const t = await getTranslations({ locale, namespace: 'meta' });
  const siteUrl = await getSiteUrl();
  // Same order as the JSON-LD: the photos of the colour the page opens on first.
  const image =
    product.ogImageUrl ??
    productImageUrls(product.images, initialSelection(product.variants).colorSlug, siteUrl)[0] ??
    null;
  return pageMetadata({
    title: `${product.metaTitle ?? `${product.name}, ${product.brand}`} | ${t('siteName')}`,
    description:
      product.metaDescription ??
      product.shortDescription ??
      htmlToSnippet(product.description, DESCRIPTION_LENGTH),
    locale,
    siteName: t('siteName'),
    alternates: buildAlternates({ siteUrl, locale, path: paths.product(slug) }),
    // A product with nothing to choose is a thin page: not indexed.
    index: !product.noindex && product.variants.length > 0,
    image,
  });
}

export default async function ProductPage({ params }: Props) {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  if (!known) notFound();

  // Existence is decided before anything streams: a missing product is a real 404.
  const product = await loadProduct(slug, locale);
  if (product === null) notFound();

  const t = await getTranslations('product');
  const tn = await getTranslations('nav');
  const siteUrl = await getSiteUrl();
  // The home URL has no trailing slash, so it equals the canonical of the home page.
  const absolute = (path: string): string => {
    const local = href(locale, path);
    return `${siteUrl}${local === '/' ? '' : local}`;
  };
  const url = absolute(paths.product(slug));
  // A Product without a photo is not eligible for rich results: no Product markup then.
  const imageUrls = productImageUrls(
    product.images,
    initialSelection(product.variants).colorSlug,
    siteUrl,
  );
  // The photo the gallery opens on is the LCP element: tell the browser about it in the first bytes
  // (AVIF only: a browser that cannot decode it skips the hint and loads the WebP normally).
  const lead = imagesForColor(product.images, initialSelection(product.variants).colorSlug)[0];
  const leadSources =
    lead === undefined ? null : renditionSources(lead.url, lead.width, lead.height);
  if (lead !== undefined && leadSources !== null) {
    preload(lead.url, {
      as: 'image',
      imageSrcSet: leadSources.avif,
      imageSizes: GALLERY_SIZES,
      fetchPriority: 'high',
      type: 'image/avif',
    });
  }
  const bands = [
    ...new Set(
      product.variants.flatMap((variant) => (variant.band === null ? [] : [variant.band])),
    ),
  ].sort((a, b) => a - b);
  const sections = [
    ['description', htmlToParagraphs(product.description)],
    ['composition', htmlToParagraphs(product.composition)],
    ['care', htmlToParagraphs(product.care)],
  ] as const;

  return (
    <SiteShell locale={locale} path={paths.product(slug)}>
      <TrackEvent event={{ name: 'view_item', items: [productItem(product)] }} />
      <JsonLd
        data={buildBreadcrumbList([
          { name: tn('home'), url: absolute(paths.home) },
          ...product.breadcrumbs.map((crumb) => ({
            name: crumb.name,
            url: absolute(paths.category(crumb.slug)),
          })),
          { name: product.name, url },
        ])}
      />
      {product.variants.length === 0 || imageUrls.length === 0 ? null : (
        <JsonLd
          data={buildProduct({
            name: product.name,
            description: htmlToSnippet(product.description, 5000),
            sku: product.sku,
            brand: product.brand,
            images: imageUrls,
            url,
            offers: uniqueOffers(product.variants, url),
            // No aggregateRating: ratings are not shown on the page yet, and
            // markup must match what the visitor sees.
            rating: null,
          })}
        />
      )}
      <Breadcrumbs
        locale={locale}
        crumbs={[
          { name: tn('home'), path: paths.home },
          ...product.breadcrumbs.map((crumb) => ({
            name: crumb.name,
            path: paths.category(crumb.slug),
          })),
          { name: product.name },
        ]}
      />
      <div className="mt-4 flex flex-col gap-1">
        <p className="text-sm text-text-muted">{product.brand}</p>
        <h1 className="font-display text-3xl">{product.name}</h1>
        <p className="text-xs text-text-muted">{t('sku', { sku: product.sku })}</p>
      </div>
      <div className="mt-6">
        <ProductBuyBox
          cartHref={href(locale, paths.cart)}
          productId={product.id}
          loginHref={href(locale, paths.accountLogin)}
          trackItems={variantItems(product)}
          name={product.name}
          images={product.images}
          colors={product.colors}
          variants={product.variants.map((variant) => ({
            id: variant.id,
            sizeLabel: variant.sizeLabel,
            sizeSystem: variant.sizeSystem,
            band: variant.band,
            cup: variant.cup,
            colorSlug: variant.colorSlug,
            available: variant.available,
            lastUnits: variant.lastUnits,
          }))}
          prices={{
            base: formatMoney(product.price, locale),
            compareAt:
              product.compareAtPrice === null ? null : formatMoney(product.compareAtPrice, locale),
            byVariant: Object.fromEntries(
              product.variants.map((variant) => [variant.id, formatMoney(variant.price, locale)]),
            ),
          }}
        />
      </div>
      <div className="mt-8 max-w-2xl divide-y divide-border border-y border-border">
        {sections.map(([key, paragraphs]) =>
          paragraphs.length === 0 ? null : (
            <details key={key} className="py-3" open={key === 'description'}>
              <summary className="min-h-6 cursor-pointer font-medium">{t(key)}</summary>
              <div className="mt-2 flex flex-col gap-2 text-sm">
                {paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </details>
          ),
        )}
        {bands.length === 0 ? null : (
          <details className="py-3">
            <summary className="min-h-6 cursor-pointer font-medium">{t('sizeGuide')}</summary>
            <div className="mt-3">
              <SizeGuide bands={bands} />
            </div>
          </details>
        )}
      </div>
    </SiteShell>
  );
}
