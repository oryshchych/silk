'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import {
  parseSizesCookie,
  sizeHint,
  SIZES_COOKIE,
  type MySizes,
  type SizedVariant,
} from '@/lib/my-sizes';

function readCookie(): MySizes {
  const found = document.cookie.split('; ').find((part) => part.startsWith(`${SIZES_COOKIE}=`));
  return parseSizesCookie(found?.slice(SIZES_COOKIE.length + 1));
}

/**
 * "Your size is available" or "your size is not available in this colour". Rendered only after
 * hydration, from the visitor's own cookie: the shared product HTML never carries it.
 */
export function MySizeNotice({
  variants,
  colorSlug,
}: {
  variants: readonly SizedVariant[];
  colorSlug: string;
}) {
  const t = useTranslations('product');
  const [saved, setSaved] = useState<MySizes | null>(null);
  useEffect(() => {
    setSaved(readCookie());
  }, []);
  if (saved === null) return null;
  const hint = sizeHint(variants, colorSlug, saved);
  if (hint.kind === 'none') return null;
  return (
    <p
      role="status"
      className={hint.kind === 'unavailable' ? 'text-sm text-danger' : 'text-sm text-text-muted'}
    >
      {hint.kind === 'available'
        ? t('mySizeAvailable', { size: hint.label })
        : t('mySizeMissing', { size: hint.label })}
    </p>
  );
}
