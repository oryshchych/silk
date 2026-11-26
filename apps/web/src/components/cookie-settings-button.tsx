'use client';

import { useTranslations } from 'next-intl';

import { CONSENT_OPEN_EVENT } from '@/lib/analytics/browser';

/** Footer control that reopens the consent choices, so a decision can be changed as easily as it was made. */
export function CookieSettingsButton() {
  const t = useTranslations('consent');
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
      }}
      className="min-h-6 rounded-sm underline focus-visible:outline-2"
    >
      {t('settings')}
    </button>
  );
}
