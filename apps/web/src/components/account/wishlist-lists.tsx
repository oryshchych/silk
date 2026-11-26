'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { cancelStockAlertAction, removeFromWishlistAction } from '@/actions/account-data';

/** The remove button of one wishlist row or one alert row; the page reloads its own data after. */
export function WishlistLists({ kind, id }: { kind: 'wishlist' | 'alert'; id: string }) {
  const t = useTranslations('account');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        start(async () => {
          if (kind === 'wishlist') await removeFromWishlistAction({ productId: id });
          else await cancelStockAlertAction({ id });
          router.refresh();
        });
      }}
      className="min-h-11 rounded-full border border-border px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
    >
      {t('remove')}
    </button>
  );
}
