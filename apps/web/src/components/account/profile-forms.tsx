'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import { saveSizesAction, setNewsletterAction, updateProfileAction } from '@/actions/account-data';
import type { CustomerActionResult } from '@/lib/account/action';
import { fieldText } from '@/lib/form-text';
import type { ProfileDto } from '@store/shared/dto/account';

const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';
const BUTTON =
  'min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';

const LOCALES = ['uk', 'en'] as const;

interface SizeOption {
  id: string;
  label: string;
}

function Status({ result }: { result: CustomerActionResult | null }) {
  const t = useTranslations('account');
  return (
    <div aria-live="polite" className="min-h-6 text-sm">
      {result === null ? null : result.ok ? (
        <p role="status">{t('saved')}</p>
      ) : (
        <p role="alert" className="text-danger">
          {t(result.code === 'invalid' ? 'error.invalid' : 'error.error')}
        </p>
      )}
    </div>
  );
}

export function ProfileForms({
  profile,
  sizes,
}: {
  profile: ProfileDto;
  sizes: { bra: SizeOption[]; apparel: SizeOption[] };
}) {
  const t = useTranslations('account');
  const ids = {
    first: useId(),
    last: useId(),
    phone: useId(),
    locale: useId(),
    bra: useId(),
    apparel: useId(),
    news: useId(),
  };
  const [pending, start] = useTransition();
  const [profileResult, setProfileResult] = useState<CustomerActionResult | null>(null);
  const [sizeResult, setSizeResult] = useState<CustomerActionResult | null>(null);
  const [newsResult, setNewsResult] = useState<CustomerActionResult | null>(null);
  const [subscribed, setSubscribed] = useState(profile.acceptsMarketing);

  return (
    <div className="flex max-w-md flex-col gap-8">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          start(async () => {
            setProfileResult(
              await updateProfileAction({
                firstName: fieldText(form, 'firstName'),
                lastName: fieldText(form, 'lastName'),
                phone: fieldText(form, 'phone'),
                locale: fieldText(form, 'locale'),
              }),
            );
          });
        }}
      >
        <p className="text-sm text-text-muted">{profile.email}</p>
        <label htmlFor={ids.first} className="flex flex-col gap-1 text-sm">
          {t('firstName')}
          <input
            id={ids.first}
            name="firstName"
            defaultValue={profile.firstName ?? ''}
            autoComplete="given-name"
            maxLength={120}
            className={FIELD}
          />
        </label>
        <label htmlFor={ids.last} className="flex flex-col gap-1 text-sm">
          {t('lastName')}
          <input
            id={ids.last}
            name="lastName"
            defaultValue={profile.lastName ?? ''}
            autoComplete="family-name"
            maxLength={120}
            className={FIELD}
          />
        </label>
        <label htmlFor={ids.phone} className="flex flex-col gap-1 text-sm">
          {t('phone')}
          <input
            id={ids.phone}
            name="phone"
            type="tel"
            defaultValue={profile.phone ?? ''}
            autoComplete="tel"
            maxLength={40}
            className={FIELD}
          />
        </label>
        <label htmlFor={ids.locale} className="flex flex-col gap-1 text-sm">
          {t('language')}
          <select id={ids.locale} name="locale" defaultValue={profile.locale} className={FIELD}>
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {t(code === 'uk' ? 'languageUk' : 'languageEn')}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={BUTTON}>
          {t('save')}
        </button>
        <Status result={profileResult} />
      </form>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const pick = (key: string): string | null => fieldText(form, key) || null;
          start(async () => {
            setSizeResult(
              await saveSizesAction({
                braSizeId: pick('braSizeId'),
                apparelSizeId: pick('apparelSizeId'),
              }),
            );
          });
        }}
      >
        <h2 className="font-display text-xl">{t('mySizes')}</h2>
        <p className="text-sm text-text-muted">{t('mySizesHint')}</p>
        <label htmlFor={ids.bra} className="flex flex-col gap-1 text-sm">
          {t('braSize')}
          <select
            id={ids.bra}
            name="braSizeId"
            defaultValue={profile.braSizeId ?? ''}
            className={FIELD}
          >
            <option value="">{t('noSize')}</option>
            {sizes.bra.map((size) => (
              <option key={size.id} value={size.id}>
                {size.label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.apparel} className="flex flex-col gap-1 text-sm">
          {t('apparelSize')}
          <select
            id={ids.apparel}
            name="apparelSizeId"
            defaultValue={profile.apparelSizeId ?? ''}
            className={FIELD}
          >
            <option value="">{t('noSize')}</option>
            {sizes.apparel.map((size) => (
              <option key={size.id} value={size.id}>
                {size.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={BUTTON}>
          {t('save')}
        </button>
        <Status result={sizeResult} />
      </form>

      <div className="flex flex-col gap-3">
        <h2 className="font-display text-xl">{t('newsletter')}</h2>
        <label htmlFor={ids.news} className="flex min-h-6 items-center gap-2 text-sm">
          <input
            id={ids.news}
            type="checkbox"
            checked={subscribed}
            disabled={pending}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              setSubscribed(next);
              start(async () => {
                const result = await setNewsletterAction({ subscribe: next });
                if (!result.ok) setSubscribed(!next);
                setNewsResult(result);
              });
            }}
            className="size-5"
          />
          {t('newsletterLabel')}
        </label>
        <Status result={newsResult} />
      </div>
    </div>
  );
}
