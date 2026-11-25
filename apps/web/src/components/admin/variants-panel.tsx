'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import {
  generateVariantsAction,
  updateVariantContentAction,
  updateVariantPricingAction,
} from '@/actions/admin-catalog';

import { buttonClass } from './auth-card';
import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

export interface VariantRow {
  id: string;
  sku: string;
  barcode: string | null;
  sizeLabel: string;
  colorName: string;
  /** Plain hryvnias for the input, '' when the product price applies. */
  priceOverride: string;
  stockQuantity: number;
  reservedQuantity: number;
  isActive: boolean;
}

const smallField = 'min-h-11 w-full min-w-24 rounded-md border border-border bg-surface px-2';

function VariantLine({
  row,
  canEdit,
  canPrice,
}: {
  row: VariantRow;
  canEdit: boolean;
  canPrice: boolean;
}) {
  const t = useTranslations('admin.editor');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const label = `${row.colorName} / ${row.sizeLabel}`;
  return (
    <tr className="border-b border-border align-top">
      <td className="px-2 py-2">{label}</td>
      <td className="px-2 py-2">
        <form
          id={`variant-${row.id}`}
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            setMessage(null);
            run(
              async () => {
                if (canEdit) {
                  const result = await updateVariantContentAction({
                    variantId: row.id,
                    sku: textOf(data, 'sku'),
                    barcode: textOf(data, 'barcode'),
                    isActive: data.get('isActive') !== null,
                  });
                  if (!result.ok) return result;
                }
                if (canPrice) {
                  const override = textOf(data, 'priceOverride').trim();
                  return await updateVariantPricingAction({
                    variantId: row.id,
                    priceOverride: override === '' ? null : override,
                  });
                }
                return { ok: true as const };
              },
              t('saved'),
              () => {
                router.refresh();
              },
            );
          }}
        >
          <label className="sr-only" htmlFor={`sku-${row.id}`}>
            {t('sku')} {label}
          </label>
          <input
            id={`sku-${row.id}`}
            name="sku"
            defaultValue={row.sku}
            readOnly={!canEdit}
            maxLength={64}
            className={smallField}
          />
        </form>
      </td>
      <td className="px-2 py-2">
        <label className="sr-only" htmlFor={`barcode-${row.id}`}>
          {t('barcode')} {label}
        </label>
        <input
          id={`barcode-${row.id}`}
          form={`variant-${row.id}`}
          name="barcode"
          defaultValue={row.barcode ?? ''}
          readOnly={!canEdit}
          maxLength={64}
          className={smallField}
        />
      </td>
      {canPrice ? (
        <td className="px-2 py-2">
          <label className="sr-only" htmlFor={`override-${row.id}`}>
            {t('override')} {label}
          </label>
          <input
            id={`override-${row.id}`}
            form={`variant-${row.id}`}
            name="priceOverride"
            defaultValue={row.priceOverride}
            inputMode="decimal"
            maxLength={16}
            className={smallField}
          />
        </td>
      ) : null}
      <td className="px-2 py-2">{row.stockQuantity}</td>
      <td className="px-2 py-2">{row.reservedQuantity}</td>
      <td className="px-2 py-2">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            form={`variant-${row.id}`}
            name="isActive"
            defaultChecked={row.isActive}
            disabled={!canEdit}
            className="size-5"
          />
          <span className="sr-only">
            {t('active')} {label}
          </span>
        </label>
      </td>
      <td className="px-2 py-2">
        {canEdit || canPrice ? (
          <>
            <button
              type="submit"
              form={`variant-${row.id}`}
              disabled={pending}
              className="min-h-11 min-w-11 rounded-md border border-border px-3"
            >
              {t('save')}
            </button>
            <StatusLine message={message} />
          </>
        ) : null}
      </td>
    </tr>
  );
}

export function VariantsPanel({
  productId,
  rows,
  sizes,
  colors,
  canEdit,
  canPrice,
}: {
  productId: string;
  rows: readonly VariantRow[];
  sizes: readonly { id: string; label: string }[];
  colors: readonly { id: string; name: string }[];
  canEdit: boolean;
  canPrice: boolean;
}) {
  const t = useTranslations('admin.editor');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const header = 'px-2 py-2 text-left font-medium';
  return (
    <section aria-labelledby="variants" className="space-y-4">
      <h2 id="variants" className="text-lg font-semibold">
        {t('variants')}
      </h2>
      {rows.length === 0 ? (
        <p>{t('noVariants')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t('variants')}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={header}>
                  {t('colors')} / {t('sizes')}
                </th>
                <th scope="col" className={header}>
                  {t('sku')}
                </th>
                <th scope="col" className={header}>
                  {t('barcode')}
                </th>
                {canPrice ? (
                  <th scope="col" className={header}>
                    {t('override')}
                  </th>
                ) : null}
                <th scope="col" className={header}>
                  {t('stock')}
                </th>
                <th scope="col" className={header}>
                  {t('reserved')}
                </th>
                <th scope="col" className={header}>
                  {t('active')}
                </th>
                <th scope="col" className={header}>
                  <span className="sr-only">{t('save')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <VariantLine key={row.id} row={row} canEdit={canEdit} canPrice={canPrice} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit ? (
        sizes.length === 0 || colors.length === 0 ? (
          <p className="text-text-muted">{t('noSizes')}</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = readForm(event.currentTarget);
              setMessage(null);
              const picked = (name: string): string[] =>
                data.getAll(name).filter((value): value is string => typeof value === 'string');
              run(
                async () => {
                  const result = await generateVariantsAction({
                    productId,
                    sizeIds: picked('sizeIds'),
                    colorIds: picked('colorIds'),
                  });
                  return result;
                },
                t('saved'),
                () => {
                  router.refresh();
                },
              );
            }}
            className="space-y-3"
          >
            <p className="text-text-muted">{t('variantsHint')}</p>
            <fieldset className="flex flex-wrap gap-x-4">
              <legend className="font-medium">{t('sizes')}</legend>
              {sizes.map((size) => (
                <label key={size.id} className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="sizeIds" value={size.id} className="size-5" />
                  {size.label}
                </label>
              ))}
            </fieldset>
            <fieldset className="flex flex-wrap gap-x-4">
              <legend className="font-medium">{t('colors')}</legend>
              {colors.map((color) => (
                <label key={color.id} className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="colorIds" value={color.id} className="size-5" />
                  {color.name}
                </label>
              ))}
            </fieldset>
            <StatusLine message={message} />
            <button type="submit" disabled={pending} className={buttonClass}>
              {t('generate')}
            </button>
          </form>
        )
      ) : null}
    </section>
  );
}
