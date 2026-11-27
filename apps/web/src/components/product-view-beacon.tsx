'use client';

import { useEffect } from 'react';

/**
 * Counts one view of this product after the page has loaded, with a beacon (`sendBeacon`: it does
 * not delay anything and survives leaving the page). The product page itself stays static and
 * cacheable: nothing about the visitor is rendered into it, the id is the product's own. It sends no
 * cookie value of its own and nothing but the id; it does nothing when the browser says "do not
 * track". Renders nothing.
 */
export function ProductViewBeacon({ productId }: { productId: string }) {
  useEffect(() => {
    if (navigator.doNotTrack === '1' || typeof navigator.sendBeacon !== 'function') return;
    navigator.sendBeacon(
      '/api/pv',
      new Blob([JSON.stringify({ productId })], { type: 'application/json' }),
    );
  }, [productId]);
  return null;
}
