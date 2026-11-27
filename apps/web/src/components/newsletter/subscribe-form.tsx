'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { subscribeNewsletterAction, type SubscribeResult } from '@/actions/unsubscribe';

const FIELD = { email: 'email', consent: 'consent', website: 'website' } as const;

/** The double opt-in form: the box must be ticked, the answer never says whether the address was known. */
export function SubscribeForm() {
  const t = useTranslations('newsletter');
  const locale = useLocale() === 'en' ? 'en' : 'uk';
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SubscribeResult | null>(null);
  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const email = data.get(FIELD.email);
        const website = data.get(FIELD.website);
        start(async () => {
          setResult(
            await subscribeNewsletterAction({
              email: typeof email === 'string' ? email : '',
              locale,
              consent: data.get(FIELD.consent) === 'on',
              website: typeof website === 'string' ? website : '',
            }),
          );
        });
      }}
    >
      <label className="flex flex-col gap-1">
        {t('email')}
        <input
          name={FIELD.email}
          type="email"
          autoComplete="email"
          required
          maxLength={320}
          className="min-h-11 rounded-md border border-border bg-surface px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
        />
      </label>
      {/* Honeypot: invisible to people and to assistive technology, filled by simple bots. */}
      <div aria-hidden="true" className="absolute -left-[9999px]">
        <input name={FIELD.website} tabIndex={-1} autoComplete="off" />
      </div>
      <label className="flex min-h-11 items-start gap-3">
        <input type="checkbox" name={FIELD.consent} className="mt-1 size-5" />
        <span>{t('consent')}</span>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {t('submit')}
      </button>
      <div aria-live="polite" className="min-h-6 text-sm">
        {result === null ? null : result.status === 'sent' ? (
          <p>{t('sent')}</p>
        ) : (
          <p className="text-danger">{t(`error.${result.code}`)}</p>
        )}
      </div>
    </form>
  );
}
