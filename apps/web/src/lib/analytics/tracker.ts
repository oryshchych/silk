/**
 * The browser side of analytics, with its environment injected so every rule is testable without
 * a browser (there is no DOM test tool, Q51). The invariants:
 *
 *  - NOTHING is requested from a tracker host before the visitor consents: `loadScript` is called
 *    only from `apply`, and only for a category that was granted;
 *  - Consent Mode v2 `default: denied` is queued first, `update` on every decision;
 *  - events fired before a decision wait in a small buffer, are sent when consent is granted and
 *    dropped when it is refused;
 *  - a purchase is sent once per order (the dedupe store), whatever the page does.
 */
import {
  consentModeSignals,
  DENIED,
  ga4Ecommerce,
  metaEvent,
  type AnalyticsConfig,
  type Consent,
  type EcommerceEvent,
} from '@store/shared/analytics';

export interface TrackerEnv {
  /** Adds a script to the page. The only way a tracker host is ever contacted. */
  loadScript: (src: string) => void;
  /** The page's `dataLayer` array (created if missing by the caller). */
  dataLayer: unknown[];
  /** Meta's `fbq` queue function; created by the tracker when absent. */
  getFbq: () => ((...args: unknown[]) => void) | undefined;
  setFbq: (fbq: (...args: unknown[]) => void) => void;
  /** Expires the cookies whose names start with one of the prefixes (host and parent domains). */
  clearCookies: (prefixes: readonly string[]) => void;
  /** Once-only memory for purchases (a tab's session storage); may throw, then dedupe is off. */
  seen: { has: (key: string) => boolean; add: (key: string) => void };
}

export interface Tracker {
  /** The visitor's decision (or the stored one). Idempotent. */
  apply: (consent: Consent) => void;
  track: (event: EcommerceEvent) => void;
  readonly consent: Consent | null;
}

const BUFFER_LIMIT = 20;
const GOOGLE = 'https://www.googletagmanager.com';
const META_SCRIPT = 'https://connect.facebook.net/en_US/fbevents.js';

export function createTracker(config: AnalyticsConfig, env: TrackerEnv): Tracker {
  let consent: Consent | null = null;
  let buffer: EcommerceEvent[] = [];
  const loaded = { google: false, meta: false };

  // gtag.js reads `Arguments` objects from the data layer, not arrays: the same function as the snippet.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameters exist only to be read through `arguments`
  function gtag(..._command: unknown[]): void {
    // eslint-disable-next-line prefer-rest-params -- an Arguments object is what gtag.js recognises
    env.dataLayer.push(arguments);
  }
  // Default first, before any decision and before any script exists.
  gtag('consent', 'default', { ...consentModeSignals(DENIED), wait_for_update: 500 });

  function loadGoogle(): void {
    if (loaded.google) return;
    if (config.gtm !== null) {
      loaded.google = true;
      env.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
      env.loadScript(`${GOOGLE}/gtm.js?id=${encodeURIComponent(config.gtm)}`);
    } else if (config.ga4 !== null) {
      loaded.google = true;
      gtag('js', new Date());
      gtag('config', config.ga4);
      env.loadScript(`${GOOGLE}/gtag/js?id=${encodeURIComponent(config.ga4)}`);
    }
  }

  function loadMeta(): void {
    if (loaded.meta || config.metaPixel === null) return;
    loaded.meta = true;
    if (env.getFbq() === undefined) {
      const queue: unknown[][] = [];
      const fbq = (...args: unknown[]): void => {
        queue.push(args);
      };
      Object.assign(fbq, { queue, loaded: true, version: '2.0' });
      env.setFbq(fbq);
    }
    const fbq = env.getFbq();
    fbq?.('init', config.metaPixel);
    fbq?.('track', 'PageView');
    env.loadScript(META_SCRIPT);
  }

  function send(event: EcommerceEvent, granted: Consent): void {
    const googleOn = granted.analytics && loaded.google;
    const metaOn = granted.marketing && loaded.meta;
    // Nothing would be sent: do not spend the once-only key either, so an opt-in later in the
    // same tab can still report the purchase.
    if (!googleOn && !metaOn) return;
    if (event.name === 'purchase' && event.reference !== undefined) {
      const key = `purchase:${event.reference}`;
      try {
        if (env.seen.has(key)) return;
        env.seen.add(key);
      } catch {
        // No storage: the page's own once-only logic is the only guard.
      }
    }
    if (googleOn) {
      const ecommerce = ga4Ecommerce(event);
      if (config.gtm !== null) {
        env.dataLayer.push({ ecommerce: null });
        env.dataLayer.push({ event: event.name, ecommerce });
      } else {
        gtag('event', event.name, ecommerce);
      }
    }
    const meta = metaOn ? metaEvent(event) : null;
    if (meta !== null) {
      env.getFbq()?.(
        'track',
        meta.name,
        meta.params,
        meta.eventId === undefined ? undefined : { eventID: meta.eventId },
      );
    }
  }

  return {
    get consent() {
      return consent;
    },
    apply(next) {
      const previous = consent;
      consent = next;
      gtag('consent', 'update', consentModeSignals(next));
      // A withdrawal must stop what already runs, not only what is loaded next: tell Meta, and
      // remove the identifiers the trackers keep in cookies.
      if (previous?.analytics === true && !next.analytics)
        env.clearCookies(['_ga', '_gid', '_gat']);
      if (previous?.marketing === true && !next.marketing) {
        if (loaded.meta) env.getFbq()?.('consent', 'revoke');
        env.clearCookies(['_fbp', '_fbc', '_gcl']);
      }
      if (previous?.marketing === false && next.marketing && loaded.meta) {
        env.getFbq()?.('consent', 'grant');
      }
      if (next.analytics || (next.marketing && config.gtm !== null)) loadGoogle();
      if (next.marketing) loadMeta();
      const pending = buffer;
      buffer = [];
      for (const event of pending) send(event, next);
    },
    track(event) {
      if (consent === null) {
        if (buffer.length < BUFFER_LIMIT) buffer.push(event);
        return;
      }
      send(event, consent);
    },
  };
}
