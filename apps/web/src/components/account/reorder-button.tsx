'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, useTransition } from 'react';

import { reorderAction } from '@/actions/account-data';
import { href, paths } from '@/lib/paths';

export function ReorderButton({
  orderNumber,
  locale,
}: {
  orderNumber: string;
  locale: 'uk' | 'en';
}) {
  const t = useTranslations('account');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof reorderAction>> | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          start(async () => {
            setResult(await reorderAction({ orderNumber }));
          });
        }}
        className="min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {t('reorder')}
      </button>
      <div aria-live="polite" className="text-sm">
        {result === null ? null : result.ok ? (
          <p role="status">
            {t('reordered', { added: result.value.added, skipped: result.value.skipped })}{' '}
            <Link href={href(locale, paths.cart)} className="underline">
              {t('openCart')}
            </Link>
          </p>
        ) : (
          <p role="alert" className="text-danger">
            {t('error.error')}
          </p>
        )}
      </div>
    </div>
  );
}
