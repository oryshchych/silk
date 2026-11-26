'use client';

/**
 * The real browser environment for the tracker, as one per-page singleton. The tracker itself
 * (`tracker.ts`) is pure and tested; this file only wires `document`, `window` and the cookie.
 */
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  parseConsent,
  serializeConsent,
  type AnalyticsConfig,
  type Consent,
  type EcommerceEvent,
} from '@store/shared/analytics';

import { createTracker, type Tracker, type TrackerEnv } from './tracker';

declare global {
  interface Window {
    dataLayer?: unknown[];
    fbq?: (...args: unknown[]) => void;
  }
}

/** Fired when the visitor asks to change the decision ("Cookie settings" in the footer). */
export const CONSENT_OPEN_EVENT = 'silk:consent-open';

let tracker: Tracker | null = null;
/** Events fired before the provider mounted: kept briefly, handed over at init. */
const early: EcommerceEvent[] = [];

export function readStoredConsent(): Consent | null {
  const part = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(`${CONSENT_COOKIE}=`));
  return parseConsent(part === undefined ? null : part.slice(CONSENT_COOKIE.length + 1));
}

function storeConsent(consent: Consent): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${CONSENT_COOKIE}=${serializeConsent(consent)}; Max-Age=${String(CONSENT_MAX_AGE_SECONDS)}; Path=/; SameSite=Lax${secure}`;
}

function browserEnv(): TrackerEnv {
  window.dataLayer ??= [];
  return {
    loadScript: (src) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = src;
      document.head.append(script);
    },
    dataLayer: window.dataLayer,
    getFbq: () => window.fbq,
    setFbq: (fbq) => {
      window.fbq = fbq;
    },
    seen: {
      has: (key) => window.sessionStorage.getItem(`silk:${key}`) !== null,
      add: (key) => {
        window.sessionStorage.setItem(`silk:${key}`, '1');
      },
    },
  };
}

/** Creates the tracker once and applies a stored decision. Returns it. */
export function initTracker(config: AnalyticsConfig): Tracker {
  if (tracker !== null) return tracker;
  tracker = createTracker(config, browserEnv());
  const stored = readStoredConsent();
  if (stored !== null) tracker.apply(stored);
  for (const event of early.splice(0)) tracker.track(event);
  return tracker;
}

export function applyConsent(consent: Consent): void {
  storeConsent(consent);
  tracker?.apply(consent);
}

/** A no-op when analytics are off (no config) or consent was refused. */
export function trackEvent(event: EcommerceEvent): void {
  if (tracker === null) {
    if (early.length < 20) early.push(event);
    return;
  }
  tracker.track(event);
}
