'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { updateProductContentAction } from '@/actions/admin-catalog';

import { buttonClass } from './auth-card';
import { CheckField, SelectField, StatusLine, TextArea, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

/** Field names, as identifiers: the form reads them back by the same names. */
const FIELD = {
  badge: 'badge',
  brand: 'brand',
  careEn: 'careEn',
  careUk: 'careUk',
  categoryId: 'categoryId',
  compositionEn: 'compositionEn',
  compositionUk: 'compositionUk',
  descriptionEn: 'descriptionEn',
  descriptionUk: 'descriptionUk',
  isFeatured: 'isFeatured',
  metaDescriptionEn: 'metaDescriptionEn',
  metaDescriptionUk: 'metaDescriptionUk',
  metaTitleEn: 'metaTitleEn',
  metaTitleUk: 'metaTitleUk',
  nameEn: 'nameEn',
  nameUk: 'nameUk',
  noindex: 'noindex',
  shortDescriptionEn: 'shortDescriptionEn',
  shortDescriptionUk: 'shortDescriptionUk',
  sku: 'sku',
  slug: 'slug',
  uktzedCode: 'uktzedCode',
  weightGrams: 'weightGrams',
} as const;

export interface ProductContentValues {
  productId: string;
  sku: string;
  slug: string;
  brand: string;
  categoryId: string;
  nameUk: string;
  nameEn: string;
  shortDescriptionUk: string | null;
  shortDescriptionEn: string | null;
  descriptionUk: string | null;
  descriptionEn: string | null;
  compositionUk: string | null;
  compositionEn: string | null;
  careUk: string | null;
  careEn: string | null;
  weightGrams: number;
  uktzedCode: string | null;
  isFeatured: boolean;
  badge: string;
  metaTitleUk: string | null;
  metaDescriptionUk: string | null;
  metaTitleEn: string | null;
  metaDescriptionEn: string | null;
  noindex: boolean;
}

const BADGES = ['none', 'new', 'sale', 'bestseller', 'last_units'] as const;

export function ProductContentForm({
  values,
  categories,
  siteHost,
}: {
  values: ProductContentValues;
  categories: readonly { value: string; label: string }[];
  siteHost: string;
}) {
  const t = useTranslations('admin.editor');
  const { message, pending, run, setMessage } = useAdminAction();
  const [metaTitle, setMetaTitle] = useState(values.metaTitleUk ?? '');
  const [metaDescription, setMetaDescription] = useState(values.metaDescriptionUk ?? '');
  const [slug, setSlug] = useState(values.slug);
  const badgeLabels: Record<(typeof BADGES)[number], string> = {
    none: t('badgeNone'),
    new: t('badgeNew'),
    sale: t('badgeSale'),
    bestseller: t('badgeBestseller'),
    last_units: t('badgeLast'),
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        setMessage(null);
        const text = (name: string): string => textOf(data, name);
        run(
          async () =>
            await updateProductContentAction({
              productId: values.productId,
              sku: text('sku'),
              slug: text('slug'),
              brand: text('brand'),
              categoryId: text('categoryId'),
              nameUk: text('nameUk'),
              nameEn: text('nameEn'),
              shortDescriptionUk: text('shortDescriptionUk'),
              shortDescriptionEn: text('shortDescriptionEn'),
              descriptionUk: text('descriptionUk'),
              descriptionEn: text('descriptionEn'),
              compositionUk: text('compositionUk'),
              compositionEn: text('compositionEn'),
              careUk: text('careUk'),
              careEn: text('careEn'),
              weightGrams: Number(text('weightGrams')),
              uktzedCode: text('uktzedCode'),
              isFeatured: data.get('isFeatured') !== null,
              badge: text('badge'),
              metaTitleUk: text('metaTitleUk'),
              metaTitleEn: text('metaTitleEn'),
              metaDescriptionUk: text('metaDescriptionUk'),
              metaDescriptionEn: text('metaDescriptionEn'),
              noindex: data.get('noindex') !== null,
            }),
          t('saved'),
        );
      }}
      className="max-w-3xl space-y-4"
    >
      <h2 className="text-lg font-semibold">{t('basics')}</h2>
      <TextField
        label={t('sku')}
        name={FIELD.sku}
        defaultValue={values.sku}
        required
        maxLength={64}
      />
      <TextField
        label={t('slug')}
        name={FIELD.slug}
        defaultValue={values.slug}
        required
        maxLength={200}
        hint={t('slugHint')}
        onChange={setSlug}
      />
      <TextField
        label={t('brand')}
        name={FIELD.brand}
        defaultValue={values.brand}
        required
        maxLength={120}
      />
      <SelectField
        label={t('category')}
        name={FIELD.categoryId}
        defaultValue={values.categoryId}
        options={categories}
      />
      <TextField
        label={t('nameUk')}
        name={FIELD.nameUk}
        defaultValue={values.nameUk}
        required
        maxLength={300}
      />
      <TextField
        label={t('nameEn')}
        name={FIELD.nameEn}
        defaultValue={values.nameEn}
        required
        maxLength={300}
      />
      <TextField
        label={t('shortUk')}
        name={FIELD.shortDescriptionUk}
        defaultValue={values.shortDescriptionUk}
        maxLength={500}
      />
      <TextField
        label={t('shortEn')}
        name={FIELD.shortDescriptionEn}
        defaultValue={values.shortDescriptionEn}
        maxLength={500}
      />
      <TextArea
        label={t('descUk')}
        name={FIELD.descriptionUk}
        defaultValue={values.descriptionUk}
        maxLength={20000}
      />
      <TextArea
        label={t('descEn')}
        name={FIELD.descriptionEn}
        defaultValue={values.descriptionEn}
        maxLength={20000}
      />
      <TextArea
        label={t('compUk')}
        name={FIELD.compositionUk}
        defaultValue={values.compositionUk}
        maxLength={5000}
        rows={2}
      />
      <TextArea
        label={t('compEn')}
        name={FIELD.compositionEn}
        defaultValue={values.compositionEn}
        maxLength={5000}
        rows={2}
      />
      <TextArea
        label={t('careUk')}
        name={FIELD.careUk}
        defaultValue={values.careUk}
        maxLength={5000}
        rows={2}
      />
      <TextArea
        label={t('careEn')}
        name={FIELD.careEn}
        defaultValue={values.careEn}
        maxLength={5000}
        rows={2}
      />
      <TextField
        label={t('weight')}
        name={FIELD.weightGrams}
        defaultValue={String(values.weightGrams)}
        inputMode="numeric"
        maxLength={6}
      />
      <TextField
        label={t('uktzed')}
        name={FIELD.uktzedCode}
        defaultValue={values.uktzedCode}
        maxLength={20}
      />
      <SelectField
        label={t('badge')}
        name={FIELD.badge}
        defaultValue={values.badge}
        options={BADGES.map((value) => ({ value, label: badgeLabels[value] }))}
      />
      <CheckField
        label={t('featured')}
        name={FIELD.isFeatured}
        defaultChecked={values.isFeatured}
      />

      <h2 className="pt-2 text-lg font-semibold">{t('seo')}</h2>
      <TextField
        label={t('metaTitleUk')}
        name={FIELD.metaTitleUk}
        defaultValue={values.metaTitleUk}
        maxLength={200}
        onChange={setMetaTitle}
      />
      <TextArea
        label={t('metaDescUk')}
        name={FIELD.metaDescriptionUk}
        defaultValue={values.metaDescriptionUk}
        maxLength={400}
        rows={2}
        onChange={setMetaDescription}
      />
      <TextField
        label={t('metaTitleEn')}
        name={FIELD.metaTitleEn}
        defaultValue={values.metaTitleEn}
        maxLength={200}
      />
      <TextArea
        label={t('metaDescEn')}
        name={FIELD.metaDescriptionEn}
        defaultValue={values.metaDescriptionEn}
        maxLength={400}
        rows={2}
      />
      <CheckField label={t('noindex')} name={FIELD.noindex} defaultChecked={values.noindex} />
      <figure
        aria-label={t('preview')}
        className="rounded-md border border-border bg-surface-raised p-3"
      >
        <figcaption className="text-sm text-text-muted">{t('preview')}</figcaption>
        <p className="break-all text-sm text-text-muted">{`${siteHost}/product/${slug}`}</p>
        <p className="text-lg text-accent underline">
          {metaTitle === '' ? values.nameUk : metaTitle}
        </p>
        <p className="text-sm">{metaDescription}</p>
      </figure>

      <StatusLine message={message} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {t('save')}
      </button>
    </form>
  );
}
