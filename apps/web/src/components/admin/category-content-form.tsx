'use client';

import { useTranslations } from 'next-intl';

import { updateCategoryContentAction } from '@/actions/admin-taxonomy';

import { buttonClass } from './auth-card';
import { CheckField, StatusLine, TextArea, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

/** Field names as identifiers: the form reads them back by the same names. */
const FIELD = {
  descriptionEn: 'descriptionEn',
  descriptionUk: 'descriptionUk',
  metaDescriptionEn: 'metaDescriptionEn',
  metaDescriptionUk: 'metaDescriptionUk',
  metaTitleEn: 'metaTitleEn',
  metaTitleUk: 'metaTitleUk',
  noindex: 'noindex',
  seoTextEn: 'seoTextEn',
  seoTextUk: 'seoTextUk',
} as const;

export interface CategoryContentValues {
  categoryId: string;
  descriptionUk: string | null;
  descriptionEn: string | null;
  seoTextUk: string | null;
  seoTextEn: string | null;
  metaTitleUk: string | null;
  metaTitleEn: string | null;
  metaDescriptionUk: string | null;
  metaDescriptionEn: string | null;
  noindex: boolean;
}

export interface CategoryBounds {
  seoMin: number;
  seoMax: number;
  titleMax: number;
  descriptionMin: number;
  descriptionMax: number;
}

/** The texts of one category: the SEO text under the product list, the short description and the search snippet. */
export function CategoryContentForm({
  values,
  bounds,
}: {
  values: CategoryContentValues;
  bounds: CategoryBounds;
}) {
  const t = useTranslations('admin.categoryEditor');
  const { message, pending, run, setMessage } = useAdminAction();
  const seoHint = t('seoHint', { min: bounds.seoMin, max: bounds.seoMax });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        setMessage(null);
        const text = (name: string): string => textOf(data, name);
        run(
          async () =>
            await updateCategoryContentAction({
              categoryId: values.categoryId,
              descriptionUk: text('descriptionUk'),
              descriptionEn: text('descriptionEn'),
              seoTextUk: text('seoTextUk'),
              seoTextEn: text('seoTextEn'),
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
      <h2 className="text-lg font-semibold">{t('seoTexts')}</h2>
      <TextArea
        label={t('seoTextUk')}
        name={FIELD.seoTextUk}
        defaultValue={values.seoTextUk}
        rows={12}
        hint={seoHint}
      />
      <TextArea
        label={t('seoTextEn')}
        name={FIELD.seoTextEn}
        defaultValue={values.seoTextEn}
        rows={12}
        hint={seoHint}
      />
      <h2 className="pt-2 text-lg font-semibold">{t('descriptions')}</h2>
      <TextArea
        label={t('descriptionUk')}
        name={FIELD.descriptionUk}
        defaultValue={values.descriptionUk}
        rows={3}
        maxLength={5000}
      />
      <TextArea
        label={t('descriptionEn')}
        name={FIELD.descriptionEn}
        defaultValue={values.descriptionEn}
        rows={3}
        maxLength={5000}
      />
      <h2 className="pt-2 text-lg font-semibold">{t('snippet')}</h2>
      <TextField
        label={t('metaTitleUk')}
        name={FIELD.metaTitleUk}
        defaultValue={values.metaTitleUk}
        maxLength={200}
        hint={t('titleHint', { max: bounds.titleMax })}
      />
      <TextArea
        label={t('metaDescriptionUk')}
        name={FIELD.metaDescriptionUk}
        defaultValue={values.metaDescriptionUk}
        rows={2}
        maxLength={400}
        hint={t('metaHint', { min: bounds.descriptionMin, max: bounds.descriptionMax })}
      />
      <TextField
        label={t('metaTitleEn')}
        name={FIELD.metaTitleEn}
        defaultValue={values.metaTitleEn}
        maxLength={200}
        hint={t('titleHint', { max: bounds.titleMax })}
      />
      <TextArea
        label={t('metaDescriptionEn')}
        name={FIELD.metaDescriptionEn}
        defaultValue={values.metaDescriptionEn}
        rows={2}
        maxLength={400}
        hint={t('metaHint', { min: bounds.descriptionMin, max: bounds.descriptionMax })}
      />
      <CheckField label={t('noindex')} name={FIELD.noindex} defaultChecked={values.noindex} />
      <StatusLine message={message} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {t('save')}
      </button>
    </form>
  );
}
