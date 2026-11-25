'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { setProductActiveAction } from '@/actions/admin-catalog';

import { buttonClass } from './auth-card';
import { StatusLine } from './fields';
import { useAdminAction } from './use-admin-action';

export function ProductPublish({ productId, isActive }: { productId: string; isActive: boolean }) {
  const t = useTranslations('admin.editor');
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  return (
    <section aria-labelledby="publishing" className="space-y-2">
      <h2 id="publishing" className="text-lg font-semibold">
        {t('publishing')}
      </h2>
      <p>{isActive ? t('statusActive') : t('statusDraft')}</p>
      <button
        type="button"
        disabled={pending}
        className={buttonClass}
        onClick={() => {
          run(
            async () => await setProductActiveAction({ productId, isActive: !isActive }),
            t('saved'),
            () => {
              router.refresh();
            },
          );
        }}
      >
        {isActive ? t('unpublish') : t('publish')}
      </button>
      <StatusLine message={message} />
    </section>
  );
}
