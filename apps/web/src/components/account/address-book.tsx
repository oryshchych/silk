'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import { addAddressAction, deleteAddressAction } from '@/actions/account-data';
import type { CustomerActionResult } from '@/lib/account/action';
import { fieldText } from '@/lib/form-text';
import type { AddressDto } from '@store/shared/dto/account';

const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';

/** Saved addresses (Ukrposhta here; Nova Poshta points come with the checkout picker, owner queue Q67). */
export function AddressBook({ addresses }: { addresses: AddressDto[] }) {
  const t = useTranslations('account');
  const router = useRouter();
  const ids = {
    name: useId(),
    phone: useId(),
    street: useId(),
    house: useId(),
    apt: useId(),
    post: useId(),
  };
  const [pending, start] = useTransition();
  const [result, setResult] = useState<CustomerActionResult<string> | CustomerActionResult | null>(
    null,
  );

  return (
    <div className="flex max-w-xl flex-col gap-6">
      {addresses.length === 0 ? <p>{t('noAddresses')}</p> : null}
      <ul className="flex flex-col gap-3">
        {addresses.map((address) => (
          <li
            key={address.id}
            className="flex items-start justify-between gap-3 rounded-sm border border-border p-3"
          >
            <div className="text-sm">
              <p className="font-medium">
                {address.recipientName}
                {address.isDefault ? ` · ${t('defaultAddress')}` : ''}
              </p>
              <p>{address.phone}</p>
              <p className="text-text-muted">
                {[
                  address.settlementName,
                  address.warehouseName,
                  address.street,
                  address.house,
                  address.apartment,
                  address.postcode,
                ]
                  .filter((part): part is string => part !== null && part !== '')
                  .join(', ')}
              </p>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                start(async () => {
                  setResult(await deleteAddressAction({ id: address.id }));
                  router.refresh();
                });
              }}
              className="min-h-11 rounded-full border border-border px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t('delete')}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const apartment = fieldText(data, 'apartment');
          start(async () => {
            const outcome = await addAddressAction({
              deliveryMethod: 'ukrposhta',
              recipientName: fieldText(data, 'recipientName'),
              phone: fieldText(data, 'phone'),
              street: fieldText(data, 'street'),
              house: fieldText(data, 'house'),
              ...(apartment === '' ? {} : { apartment }),
              postcode: fieldText(data, 'postcode'),
              isDefault: data.get('isDefault') === 'on',
            });
            setResult(outcome);
            if (outcome.ok) {
              form.reset();
              router.refresh();
            }
          });
        }}
      >
        <h2 className="font-display text-xl">{t('addAddress')}</h2>
        <label htmlFor={ids.name} className="flex flex-col gap-1 text-sm">
          {t('recipient')}
          <input
            id={ids.name}
            name="recipientName"
            required
            maxLength={240}
            autoComplete="name"
            className={FIELD}
          />
        </label>
        <label htmlFor={ids.phone} className="flex flex-col gap-1 text-sm">
          {t('phone')}
          <input
            id={ids.phone}
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            className={FIELD}
          />
        </label>
        <label htmlFor={ids.street} className="flex flex-col gap-1 text-sm">
          {t('street')}
          <input
            id={ids.street}
            name="street"
            required
            maxLength={240}
            autoComplete="address-line1"
            className={FIELD}
          />
        </label>
        <label htmlFor={ids.house} className="flex flex-col gap-1 text-sm">
          {t('house')}
          <input id={ids.house} name="house" required maxLength={40} className={FIELD} />
        </label>
        <label htmlFor={ids.apt} className="flex flex-col gap-1 text-sm">
          {t('apartment')}
          <input id={ids.apt} name="apartment" maxLength={40} className={FIELD} />
        </label>
        <label htmlFor={ids.post} className="flex flex-col gap-1 text-sm">
          {t('postcode')}
          <input
            id={ids.post}
            name="postcode"
            required
            inputMode="numeric"
            pattern="\d{5}"
            autoComplete="postal-code"
            className={FIELD}
          />
        </label>
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input name="isDefault" type="checkbox" className="size-5" />
          {t('makeDefault')}
        </label>
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          {t('save')}
        </button>
        <div aria-live="polite" className="min-h-6 text-sm">
          {result === null ? null : result.ok ? (
            <p role="status">{t('saved')}</p>
          ) : (
            <p role="alert" className="text-danger">
              {t(result.code === 'invalid' ? 'error.invalid' : 'error.error')}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
