'use client';

import { calculateDiscount } from '@store/core/pricing';
import type { AdminPromoRowDto } from '@store/shared/dto/admin-promo';
import { generatePromoCode } from '@store/shared/promo-code';
import { formatMoney, money, parseHryvnias, toHryvniasText } from '@store/shared/money';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { createPromoCodeAction, updatePromoCodeAction } from '../../actions/admin-promo';

import { buttonClass } from './auth-card';
import { CheckField, SelectField, StatusLine, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

/** Field names as identifiers: the form reads them back by the same names. */
const F = {
  code: 'code',
  description: 'description',
  type: 'type',
  value: 'value',
  cap: 'maxDiscountAmount',
  min: 'minOrderTotal',
  maxUses: 'maxUses',
  perCustomer: 'perCustomerLimit',
  scope: 'scope',
  category: 'scopeCategoryId',
  product: 'scopeProductId',
  stackable: 'stackable',
  discounted: 'excludesDiscountedItems',
  first: 'firstOrderOnly',
  gift: 'excludesGiftCards',
  starts: 'startsAt',
  ends: 'endsAt',
  active: 'isActive',
} as const;

const TYPE_VALUES = ['percent', 'fixed', 'free_shipping'] as const;
const SCOPE_VALUES = ['all', 'category', 'product'] as const;

export interface PromoFormProps {
  /** Present when editing: the code is then fixed and the frozen fields are locked after a redemption. */
  existing?: {
    row: AdminPromoRowDto;
    startsAtLocal: string;
    endsAtLocal: string;
  };
  categories: readonly { id: string; name: string }[];
}

const asText = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

function previewText(
  data: FormData,
  cart: string,
  locale: 'uk' | 'en',
  labels: { shipping: string; invalid: string },
): string {
  try {
    const type = textOf(data, F.type);
    const base = parseHryvnias(cart);
    if (type === 'free_shipping') return labels.shipping;
    const cap = textOf(data, F.cap).trim();
    const raw = textOf(data, F.value).trim();
    const value = type === 'fixed' ? parseHryvnias(raw) : money(Number(raw));
    const discount = calculateDiscount(
      {
        type: type === 'fixed' ? 'fixed' : 'percent',
        value,
        maxDiscountAmount: type === 'percent' && cap !== '' ? parseHryvnias(cap) : null,
      },
      base,
    );
    return `${formatMoney(base, locale)} → −${formatMoney(discount, locale)}`;
  } catch {
    return labels.invalid;
  }
}

export function PromoForm({ existing, categories }: PromoFormProps) {
  const t = useTranslations('admin.promo');
  const locale = useLocale() === 'en' ? 'en' : 'uk';
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  const row = existing?.row;
  const frozen = row?.hasRedemptions === true;
  const [type, setType] = useState<string>(row?.type ?? 'percent');
  const [scope, setScope] = useState<string>(row?.scope ?? 'all');
  const [generated, setGenerated] = useState('');
  const [preview, setPreview] = useState('');
  const [cart, setCart] = useState('1500');

  const refresh = (form: HTMLFormElement | null) => {
    if (form !== null)
      setPreview(
        previewText(readForm(form), cart, locale, {
          shipping: t('previewShipping'),
          invalid: t('previewInvalid'),
        }),
      );
  };

  return (
    <form
      className="flex max-w-xl flex-col gap-3"
      onChange={(event) => {
        refresh(event.currentTarget);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        const flag = (name: string) => data.get(name) === 'on';
        const body = {
          description: textOf(data, F.description),
          type,
          value: type === 'free_shipping' ? '0' : textOf(data, F.value),
          maxDiscountAmount: type === 'percent' ? textOf(data, F.cap) : '',
          minOrderTotal: textOf(data, F.min).trim() === '' ? '0' : textOf(data, F.min),
          maxUses: textOf(data, F.maxUses),
          perCustomerLimit: textOf(data, F.perCustomer),
          scope,
          scopeCategoryId: scope === 'category' ? textOf(data, F.category) : '',
          scopeProductId: scope === 'product' ? textOf(data, F.product) : '',
          stackable: flag(F.stackable),
          excludesDiscountedItems: flag(F.discounted),
          firstOrderOnly: flag(F.first),
          excludesGiftCards: flag(F.gift),
          startsAt: textOf(data, F.starts),
          endsAt: textOf(data, F.ends),
          isActive: flag(F.active),
        };
        run(
          async () =>
            row === undefined
              ? await createPromoCodeAction({ ...body, code: textOf(data, F.code) })
              : await updatePromoCodeAction({ ...body, id: row.id }),
          t('saved'),
          () => {
            router.push('/admin/marketing/promo-codes');
            router.refresh();
          },
        );
      }}
    >
      {row === undefined ? (
        <div className="flex items-end gap-2">
          <TextField
            label={t('code')}
            name={F.code}
            maxLength={32}
            required
            defaultValue={generated}
            key={generated}
          />
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              const bytes = new Uint32Array(1);
              setGenerated(
                generatePromoCode((limit) => {
                  crypto.getRandomValues(bytes);
                  return (bytes[0] ?? 0) % limit;
                }),
              );
            }}
          >
            {t('generate')}
          </button>
        </div>
      ) : (
        <p>
          <strong>{row.code}</strong>
        </p>
      )}
      <TextField
        label={t('description')}
        name={F.description}
        defaultValue={row?.description}
        maxLength={300}
      />
      {frozen ? <p role="note">{t('frozenNote')}</p> : null}
      <label className="block">
        {t('type')}
        <select
          name={F.type}
          value={type}
          disabled={frozen}
          onChange={(event) => {
            setType(event.currentTarget.value);
          }}
          className="mt-1 block min-h-11 w-full rounded-md border border-border px-3"
        >
          {TYPE_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`types.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {type === 'free_shipping' ? null : (
        <TextField
          label={type === 'percent' ? t('valuePercent') : t('valueFixed')}
          name={F.value}
          defaultValue={
            row === undefined
              ? ''
              : row.type === 'fixed'
                ? toHryvniasText(money(row.value))
                : String(row.value)
          }
          inputMode="decimal"
          maxLength={16}
          required
        />
      )}
      {type === 'percent' ? (
        <TextField
          label={t('cap')}
          name={F.cap}
          hint={t('capHint')}
          defaultValue={
            row?.maxDiscountAmount === null || row === undefined
              ? ''
              : toHryvniasText(row.maxDiscountAmount)
          }
          inputMode="decimal"
          maxLength={16}
        />
      ) : null}
      <TextField
        label={t('minOrder')}
        name={F.min}
        defaultValue={row === undefined ? '0' : toHryvniasText(row.minOrderTotal)}
        inputMode="decimal"
        maxLength={16}
      />
      <TextField
        label={t('maxUses')}
        name={F.maxUses}
        defaultValue={asText(row?.maxUses)}
        inputMode="numeric"
        maxLength={7}
      />
      <TextField
        label={t('perCustomer')}
        name={F.perCustomer}
        hint={t('perCustomerHint')}
        defaultValue={asText(row?.perCustomerLimit)}
        inputMode="numeric"
        maxLength={7}
      />
      <label className="block">
        {t('scope')}
        <select
          name={F.scope}
          value={scope}
          disabled={frozen}
          onChange={(event) => {
            setScope(event.currentTarget.value);
          }}
          className="mt-1 block min-h-11 w-full rounded-md border border-border px-3"
        >
          {SCOPE_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`scopes.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {scope === 'category' ? (
        <SelectField
          label={t('category')}
          name={F.category}
          defaultValue={row?.scopeCategoryId ?? categories[0]?.id}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
      ) : null}
      {scope === 'product' ? (
        <TextField
          label={t('product')}
          name={F.product}
          hint={t('productHint')}
          defaultValue={row?.scopeProductId}
          maxLength={36}
          required
        />
      ) : null}
      <CheckField
        label={t('stackable')}
        name={F.stackable}
        defaultChecked={row?.stackable ?? false}
      />
      <CheckField
        label={t('excludesDiscounted')}
        name={F.discounted}
        defaultChecked={row?.excludesDiscountedItems ?? false}
      />
      <CheckField
        label={t('firstOrderOnly')}
        name={F.first}
        defaultChecked={row?.firstOrderOnly ?? false}
      />
      <CheckField
        label={t('excludesGiftCards')}
        name={F.gift}
        defaultChecked={row?.excludesGiftCards ?? true}
      />
      <label className="block">
        {t('startsAt')}
        <input
          type="datetime-local"
          name={F.starts}
          defaultValue={existing?.startsAtLocal ?? ''}
          className="mt-1 block min-h-11 w-full rounded-md border border-border px-3"
        />
      </label>
      <label className="block">
        {t('endsAt')}
        <input
          type="datetime-local"
          name={F.ends}
          defaultValue={existing?.endsAtLocal ?? ''}
          className="mt-1 block min-h-11 w-full rounded-md border border-border px-3"
        />
      </label>
      <p className="text-sm text-text-muted">{t('timezoneNote')}</p>
      <CheckField label={t('isActive')} name={F.active} defaultChecked={row?.isActive ?? true} />
      <fieldset className="rounded-md border border-border p-3">
        <legend>{t('preview')}</legend>
        <label className="block">
          {t('previewCart')}
          <input
            value={cart}
            inputMode="decimal"
            onChange={(event) => {
              setCart(event.currentTarget.value);
            }}
            className="mt-1 block min-h-11 w-40 rounded-md border border-border px-3"
          />
        </label>
        <p aria-live="polite" className="mt-2 font-semibold">
          {preview}
        </p>
      </fieldset>
      <button type="submit" disabled={pending} className={`${buttonClass} w-fit`}>
        {t('save')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
