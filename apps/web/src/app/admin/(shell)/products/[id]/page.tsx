import {
  getAdminProduct,
  listAdminAttributes,
  listAdminCategories,
  listAdminColors,
  listAdminSizes,
  listProductAttributeValueIds,
} from '@store/core/admin-read';
import { listAdminImages } from '@store/core/admin-images';
import { can } from '@store/core/auth-permissions';
import { toHryvniasText, money } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { ImagesPanel } from '@/components/admin/images-panel';
import { ProductAttributes } from '@/components/admin/product-attributes';
import { ProductContentForm } from '@/components/admin/product-content-form';
import { ProductPricingForm } from '@/components/admin/product-pricing-form';
import { ProductPublish } from '@/components/admin/product-publish';
import { VariantsPanel } from '@/components/admin/variants-panel';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { runtimeEnv } from '@/lib/runtime-env';

export default async function ProductEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireFullSession();
  const parsedId = z.uuid().safeParse((await params).id);
  if (!parsedId.success) notFound();
  const canSeeCost = can(session.role, 'catalog.cost.view');
  const canPrice = can(session.role, 'catalog.price');
  const canEdit = can(session.role, 'catalog.edit');
  const db = await getDb();
  // The DTO for THIS role: the cost key does not exist for a role that may not see it.
  const product = await getAdminProduct(db, parsedId.data, canSeeCost);
  if (product === null) notFound();
  const [categories, sizes, colors, attributes, selectedValues, images] = await Promise.all([
    listAdminCategories(db),
    listAdminSizes(db),
    listAdminColors(db),
    listAdminAttributes(db),
    listProductAttributeValueIds(db, parsedId.data),
    listAdminImages(db, parsedId.data),
  ]);
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.editor' });
  const env = await runtimeEnv();
  const siteHost = new URL(env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost').host;
  const text = (value: number | null): string =>
    value === null ? '' : toHryvniasText(money(value));
  const cost = 'costPrice' in product ? text(product.costPrice) : '';

  return (
    <div className="space-y-10">
      <div>
        <a href="/admin/products" className="inline-flex min-h-11 items-center underline">
          {t('back')}
        </a>
        <h1 className="text-2xl font-semibold">{product.nameUk}</h1>
      </div>
      {can(session.role, 'catalog.publish') ? (
        <ProductPublish productId={product.id} isActive={product.isActive} />
      ) : null}
      {canEdit ? (
        <ProductContentForm
          values={{
            productId: product.id,
            sku: product.sku,
            slug: product.slug,
            brand: product.brand,
            categoryId: product.categoryId,
            nameUk: product.nameUk,
            nameEn: product.nameEn,
            shortDescriptionUk: product.shortDescriptionUk,
            shortDescriptionEn: product.shortDescriptionEn,
            descriptionUk: product.descriptionUk,
            descriptionEn: product.descriptionEn,
            compositionUk: product.compositionUk,
            compositionEn: product.compositionEn,
            careUk: product.careUk,
            careEn: product.careEn,
            weightGrams: product.weightGrams,
            uktzedCode: product.uktzedCode,
            isFeatured: product.isFeatured,
            badge: product.badge,
            metaTitleUk: product.metaTitleUk,
            metaTitleEn: product.metaTitleEn,
            metaDescriptionUk: product.metaDescriptionUk,
            metaDescriptionEn: product.metaDescriptionEn,
            noindex: product.noindex,
          }}
          categories={categories.map((category) => ({
            value: category.id,
            label: `${'— '.repeat(category.depth)}${locale === 'en' ? category.nameEn : category.nameUk}`,
          }))}
          siteHost={siteHost}
        />
      ) : null}
      <ImagesPanel
        productId={product.id}
        canEdit={can(session.role, 'media.upload')}
        colors={colors}
        images={images.map((image) => ({
          id: image.id,
          thumbUrl: image.thumbUrl,
          altUk: image.altUk,
          altEn: image.altEn,
          colorId: image.colorId,
          sortOrder: image.sortOrder,
          width: image.width,
          height: image.height,
        }))}
      />
      <ProductAttributes
        productId={product.id}
        canEdit={canEdit}
        selected={selectedValues}
        attributes={attributes
          .filter((attribute) => attribute.values.length > 0)
          .map((attribute) => ({
            id: attribute.id,
            name: locale === 'en' ? attribute.nameEn : attribute.nameUk,
            values: attribute.values.map((value) => ({
              id: value.id,
              label: locale === 'en' ? value.valueEn : value.valueUk,
            })),
          }))}
      />
      {canPrice ? (
        <ProductPricingForm
          productId={product.id}
          price={text(product.basePrice)}
          compareAt={text(product.compareAtPrice)}
          cost={cost}
          showCost={canSeeCost}
        />
      ) : null}
      <VariantsPanel
        productId={product.id}
        rows={product.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          barcode: variant.barcode,
          sizeLabel: variant.sizeLabel,
          colorName: variant.colorName,
          priceOverride: text(variant.priceOverride),
          stockQuantity: variant.stockQuantity,
          reservedQuantity: variant.reservedQuantity,
          isActive: variant.isActive,
        }))}
        sizes={sizes}
        colors={colors}
        canEdit={canEdit}
        canPrice={canPrice}
      />
    </div>
  );
}
