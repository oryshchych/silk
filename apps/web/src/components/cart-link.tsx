'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CART_CHANGED_EVENT, CART_COUNT_COOKIE } from '@/lib/cart-events';

function readCount(): number {
  const match = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${CART_COUNT_COOKIE}=`));
  const value = Number(match?.split('=')[1] ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Header cart link. The page itself is cached and shared, so the count is read in the browser
 * from a plain cookie the cart actions keep up to date (it is a number, not a secret).
 */
export function CartLink({ href }: { href: string }) {
  const t = useTranslations('nav');
  const [count, setCount] = useState(0);

  useEffect(() => {
    const update = (): void => {
      setCount(readCount());
    };
    update();
    window.addEventListener(CART_CHANGED_EVENT, update);
    window.addEventListener('pageshow', update);
    return () => {
      window.removeEventListener(CART_CHANGED_EVENT, update);
      window.removeEventListener('pageshow', update);
    };
  }, []);

  return (
    <Link
      href={href}
      aria-label={count === 0 ? t('cart') : t('cartCount', { count })}
      className="inline-flex min-h-8 items-center gap-2 rounded-full border border-border px-3 py-1 text-sm hover:bg-surface-raised"
    >
      {t('cart')}
      {count === 0 ? null : (
        <span className="rounded-full bg-accent px-2 text-xs text-accent-contrast">{count}</span>
      )}
    </Link>
  );
}
