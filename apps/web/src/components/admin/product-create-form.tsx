'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { createProductAction } from '@/actions/admin-catalog';

import { buttonClass } from './auth-card';
import { SelectField, StatusLine, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

/** Field names, as identifiers: the form reads them back by the same names. */
const FIELD = {
  basePrice: 'basePrice',
  brand: 'brand',
  categoryId: 'categoryId',
  costPrice: 'costPrice',
  nameEn: 'nameEn',
  nameUk: 'nameUk',
  sku: 'sku',
  slug: 'slug',
  weightGrams: 'weightGrams',
} as const;

export function ProductCreateForm({
  categories,
  canSetCost,
}: {
  categories: readonly { value: string; label: string }[];
  canSetCost: boolean;
}) {
  const t = useTranslations('admin.editor');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        setMessage(null);
        run(async () => {
          const cost = textOf(data, 'costPrice').trim();
          const result = await createProductAction({
            sku: textOf(data, 'sku'),
            slug: textOf(data, 'slug'),
            brand: textOf(data, 'brand'),
            categoryId: textOf(data, 'categoryId'),
            nameUk: textOf(data, 'nameUk'),
            nameEn: textOf(data, 'nameEn'),
            basePrice: textOf(data, 'basePrice'),
            ...(canSetCost && cost !== '' ? { costPrice: cost } : {}),
            weightGrams: Number(textOf(data, 'weightGrams') || '200'),
          });
          if (result.ok) router.push(`/admin/products/${result.data.productId}`);
          return result;
        }, t('saved'));
      }}
      className="max-w-2xl space-y-4"
    >
      <TextField label={t('sku')} name={FIELD.sku} required maxLength={64} />
      <TextField
        label={t('slug')}
        name={FIELD.slug}
        required
        maxLength={200}
        hint={t('slugHint')}
      />
      <TextField label={t('brand')} name={FIELD.brand} required maxLength={120} />
      <SelectField label={t('category')} name={FIELD.categoryId} options={categories} />
      <TextField label={t('nameUk')} name={FIELD.nameUk} required maxLength={300} />
      <TextField label={t('nameEn')} name={FIELD.nameEn} required maxLength={300} />
      <TextField
        label={t('price')}
        name={FIELD.basePrice}
        required
        inputMode="decimal"
        maxLength={16}
      />
      {canSetCost ? (
        <TextField label={t('cost')} name={FIELD.costPrice} inputMode="decimal" maxLength={16} />
      ) : null}
      <TextField
        label={t('weight')}
        name={FIELD.weightGrams}
        inputMode="numeric"
        defaultValue="200"
        maxLength={6}
      />
      <StatusLine message={message} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {t('create')}
      </button>
    </form>
  );
}
