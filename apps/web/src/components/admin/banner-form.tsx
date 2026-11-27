'use client';

import type { AdminBannerDto } from '@store/shared/dto/banner';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import {
  createBannerAction,
  deleteBannerAction,
  updateBannerAction,
} from '@/actions/admin-banners';

import { buttonClass } from './auth-card';
import { CheckField, StatusLine, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const F = {
  titleUk: 'titleUk',
  titleEn: 'titleEn',
  subtitleUk: 'subtitleUk',
  subtitleEn: 'subtitleEn',
  ctaLabelUk: 'ctaLabelUk',
  ctaLabelEn: 'ctaLabelEn',
  altUk: 'altUk',
  altEn: 'altEn',
  href: 'href',
  startsAt: 'startsAt',
  endsAt: 'endsAt',
  sortOrder: 'sortOrder',
  isActive: 'isActive',
} as const;

const TEXT_FIELDS = [
  [F.titleUk, 200],
  [F.titleEn, 200],
  [F.subtitleUk, 300],
  [F.subtitleEn, 300],
  [F.ctaLabelUk, 80],
  [F.ctaLabelEn, 80],
  [F.altUk, 300],
  [F.altEn, 300],
] as const;

export function BannerForm({
  existing,
}: {
  existing?: { banner: AdminBannerDto; startsAtLocal: string; endsAtLocal: string };
}) {
  const t = useTranslations('admin.banners');
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  const banner = existing?.banner;
  const valueOf = (name: (typeof TEXT_FIELDS)[number][0]): string => banner?.[name] ?? '';
  return (
    <form
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        const body = {
          titleUk: textOf(data, F.titleUk),
          titleEn: textOf(data, F.titleEn),
          subtitleUk: textOf(data, F.subtitleUk),
          subtitleEn: textOf(data, F.subtitleEn),
          ctaLabelUk: textOf(data, F.ctaLabelUk),
          ctaLabelEn: textOf(data, F.ctaLabelEn),
          altUk: textOf(data, F.altUk),
          altEn: textOf(data, F.altEn),
          href: textOf(data, F.href),
          startsAt: textOf(data, F.startsAt),
          endsAt: textOf(data, F.endsAt),
          sortOrder: textOf(data, F.sortOrder) === '' ? '0' : textOf(data, F.sortOrder),
          isActive: data.get(F.isActive) === 'on',
        };
        let createdId: string | null = null;
        run(
          async () => {
            if (banner !== undefined) return await updateBannerAction({ ...body, id: banner.id });
            const created = await createBannerAction(body);
            if (created.ok) createdId = created.data.id;
            return created;
          },
          t('saved'),
          () => {
            if (banner === undefined) {
              router.push(
                createdId === null
                  ? '/admin/marketing/banners'
                  : `/admin/marketing/banners/${createdId}`,
              );
            } else {
              router.refresh();
            }
          },
        );
      }}
    >
      {TEXT_FIELDS.map(([name, max]) => (
        <TextField
          key={name}
          label={t(`fields.${name}`)}
          name={name}
          defaultValue={valueOf(name)}
          maxLength={max}
        />
      ))}
      <TextField
        label={t('fields.href')}
        name={F.href}
        hint={t('hrefHint')}
        defaultValue={banner?.href}
        maxLength={300}
      />
      <label className="block">
        {t('fields.startsAt')}
        <input
          type="datetime-local"
          name={F.startsAt}
          defaultValue={existing?.startsAtLocal ?? ''}
          className="mt-1 block min-h-11 w-full rounded-md border border-border px-3"
        />
      </label>
      <label className="block">
        {t('fields.endsAt')}
        <input
          type="datetime-local"
          name={F.endsAt}
          defaultValue={existing?.endsAtLocal ?? ''}
          className="mt-1 block min-h-11 w-full rounded-md border border-border px-3"
        />
      </label>
      <p className="text-sm text-text-muted">{t('timezoneNote')}</p>
      <TextField
        label={t('fields.sortOrder')}
        name={F.sortOrder}
        defaultValue={String(banner?.sortOrder ?? 0)}
        inputMode="numeric"
        maxLength={6}
      />
      {banner === undefined ? null : (
        <CheckField
          label={t('fields.isActive')}
          name={F.isActive}
          defaultChecked={banner.isActive}
        />
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={pending} className={buttonClass}>
          {t('save')}
        </button>
        {banner === undefined ? null : (
          <button
            type="button"
            disabled={pending}
            className={buttonClass}
            onClick={() => {
              if (!window.confirm(t('confirmDelete'))) return;
              run(
                async () => await deleteBannerAction({ id: banner.id }),
                t('deleted'),
                () => {
                  router.push('/admin/marketing/banners');
                },
              );
            }}
          >
            {t('delete')}
          </button>
        )}
      </div>
      <StatusLine message={message} />
    </form>
  );
}
