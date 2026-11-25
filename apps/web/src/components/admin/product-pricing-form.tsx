'use client';

import { useTranslations } from 'next-intl';

import { updateProductPricingAction } from '@/actions/admin-catalog';

import { buttonClass } from './auth-card';
import { StatusLine, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

/**
 * Shown only to a role with `catalog.price` (the server page decides; the action checks again).
 * `cost` is null for a role that may not see the cost: the field is then not rendered at all and
 * not sent.
 */
/** Field names, as identifiers: the form reads them back by the same names. */
const FIELD = {
  basePrice: 'basePrice',
  compareAtPrice: 'compareAtPrice',
  costPrice: 'costPrice',
} as const;

export function ProductPricingForm({
  productId,
  price,
  compareAt,
  cost,
  showCost,
}: {
  productId: string;
  price: string;
  compareAt: string;
  cost: string;
  showCost: boolean;
}) {
  const t = useTranslations('admin.editor');
  const { message, pending, run, setMessage } = useAdminAction();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        setMessage(null);
        run(async () => {
          const compare = textOf(data, 'compareAtPrice').trim();
          const costText = textOf(data, 'costPrice').trim();
          return await updateProductPricingAction({
            productId,
            basePrice: textOf(data, 'basePrice'),
            compareAtPrice: compare === '' ? null : compare,
            ...(showCost ? { costPrice: costText === '' ? null : costText } : {}),
          });
        }, t('saved'));
      }}
      className="max-w-md space-y-4"
    >
      <h2 className="text-lg font-semibold">{t('pricing')}</h2>
      <TextField
        label={t('price')}
        name={FIELD.basePrice}
        defaultValue={price}
        required
        inputMode="decimal"
        maxLength={16}
      />
      <TextField
        label={t('compare')}
        name={FIELD.compareAtPrice}
        defaultValue={compareAt}
        inputMode="decimal"
        maxLength={16}
      />
      {showCost ? (
        <TextField
          label={t('cost')}
          name={FIELD.costPrice}
          defaultValue={cost}
          inputMode="decimal"
          maxLength={16}
        />
      ) : null}
      <StatusLine message={message} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {t('save')}
      </button>
    </form>
  );
}
