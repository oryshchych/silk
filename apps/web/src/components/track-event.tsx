'use client';

import { useEffect } from 'react';

import type { EcommerceEvent } from '@store/shared/analytics';

import { trackEvent } from '@/lib/analytics/browser';

/**
 * Sends one e-commerce event when the page shows. The payload is built on the server from the
 * database values the page already rendered; nothing here reads the page or a price from the
 * browser. Renders nothing.
 */
export function TrackEvent({ event }: { event: EcommerceEvent }) {
  // The event object is rebuilt on every server render, so the effect keys on its content.
  const key = JSON.stringify(event);
  useEffect(() => {
    trackEvent(event);
  }, [key]);
  return null;
}
