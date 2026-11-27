'use client';

import type { AdminBannerDto } from '@store/shared/dto/banner';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { StatusLine } from './fields';

const UPLOAD_CODES = [
  'TOO_LARGE',
  'IMAGE_UNSUPPORTED_TYPE',
  'IMAGE_TOO_LARGE',
  'IMAGE_CORRUPT',
  'BUSY',
  'RATE_LIMITED',
  'MEDIA_NOT_CONFIGURED',
  'GENERIC',
] as const;
const SLOT_LABEL = { desktop: 'desktop', mobile: 'mobile' } as const;

/** One picture slot: the raw file is POSTed to the upload route (not a server action: a picture is megabytes). */
export function BannerImageUpload({
  bannerId,
  slot,
  picture,
}: {
  bannerId: string;
  slot: 'desktop' | 'mobile';
  picture: AdminBannerDto['desktop'];
}) {
  const t = useTranslations('admin.banners');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  return (
    <div className="rounded-md border border-border p-3">
      <h3 className="font-semibold">{t(SLOT_LABEL[slot])}</h3>
      {picture === null ? (
        <p className="text-text-muted">{t('noPicture')}</p>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- an admin preview of the stored rendition
        <img
          src={picture.url}
          alt=""
          width={picture.width}
          height={picture.height}
          className="mt-2 max-h-40 w-auto"
        />
      )}
      <label className="mt-2 block">
        {t('upload')}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={pending}
          className="mt-1 block min-h-11 w-full"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file === undefined) return;
            setPending(true);
            setMessage({ kind: 'ok', text: t('uploading') });
            void (async () => {
              try {
                const response = await fetch(
                  `/admin/upload/banner-image?bannerId=${encodeURIComponent(bannerId)}&slot=${slot}`,
                  { method: 'POST', body: file },
                );
                if (response.ok) {
                  setMessage({ kind: 'ok', text: t('uploaded') });
                  router.refresh();
                } else {
                  const body: unknown = await response.json().catch(() => null);
                  const code =
                    typeof body === 'object' &&
                    body !== null &&
                    'code' in body &&
                    typeof body.code === 'string'
                      ? body.code
                      : 'GENERIC';
                  const known = UPLOAD_CODES.find((c) => c === code) ?? 'GENERIC';
                  setMessage({ kind: 'error', text: t(`uploadErrors.${known}`) });
                }
              } catch {
                setMessage({ kind: 'error', text: t('uploadErrors.GENERIC') });
              } finally {
                setPending(false);
              }
            })();
          }}
        />
      </label>
      <StatusLine message={message} />
    </div>
  );
}
