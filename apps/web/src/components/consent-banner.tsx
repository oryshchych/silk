'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import type { AnalyticsConfig, Consent } from '@store/shared/analytics';

import {
  applyConsent,
  CONSENT_OPEN_EVENT,
  initTracker,
  readStoredConsent,
} from '@/lib/analytics/browser';

const BUTTON =
  'min-h-11 rounded-full border border-border px-5 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2';
const PRIMARY = `${BUTTON} bg-accent text-accent-contrast`;

/**
 * Cookie banner and the loader of the trackers. Rendered only after mount (the decision lives in a
 * cookie the cached page cannot see), and only when analytics are configured. No tracker host is
 * contacted before the visitor decides: see `lib/analytics/tracker.ts`.
 */
export function ConsentBanner({ config }: { config: AnalyticsConfig }) {
  const t = useTranslations('consent');
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const headingId = useId();

  useEffect(() => {
    initTracker(config);
    const stored = readStoredConsent();
    if (stored === null) setOpen(true);
    else {
      setAnalytics(stored.analytics);
      setMarketing(stored.marketing);
    }
    const reopen = (): void => {
      const current = readStoredConsent();
      setAnalytics(current?.analytics ?? false);
      setMarketing(current?.marketing ?? false);
      setDetails(true);
      setOpen(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, reopen);
    return () => {
      window.removeEventListener(CONSENT_OPEN_EVENT, reopen);
    };
  }, [config]);

  function decide(consent: Consent): void {
    applyConsent(consent);
    setAnalytics(consent.analytics);
    setMarketing(consent.marketing);
    setOpen(false);
    setDetails(false);
  }

  if (!open) return null;
  return (
    <section
      role="region"
      aria-labelledby={headingId}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface p-4 shadow-lg"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <h2 id={headingId} className="font-medium">
          {t('title')}
        </h2>
        <p className="text-sm">{t('text')}</p>
        {details ? (
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="sr-only">{t('title')}</legend>
            <label className="flex min-h-6 items-center gap-2">
              <input type="checkbox" checked disabled className="size-5" />
              {t('necessary')}
            </label>
            <label className="flex min-h-6 items-center gap-2">
              <input
                type="checkbox"
                checked={analytics}
                onChange={(event) => {
                  setAnalytics(event.target.checked);
                }}
                className="size-5"
              />
              {t('analytics')}
            </label>
            <label className="flex min-h-6 items-center gap-2">
              <input
                type="checkbox"
                checked={marketing}
                onChange={(event) => {
                  setMarketing(event.target.checked);
                }}
                className="size-5"
              />
              {t('marketing')}
            </label>
          </fieldset>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={PRIMARY}
            onClick={() => {
              decide({ analytics: true, marketing: true });
            }}
          >
            {t('acceptAll')}
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              decide({ analytics: false, marketing: false });
            }}
          >
            {t('rejectAll')}
          </button>
          {details ? (
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                decide({ analytics, marketing });
              }}
            >
              {t('save')}
            </button>
          ) : (
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setDetails(true);
              }}
            >
              {t('customize')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
