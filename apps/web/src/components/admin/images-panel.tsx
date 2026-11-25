'use client';

import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { deleteProductImageAction, updateProductImageAction } from '@/actions/admin-catalog';

import { buttonClass } from './auth-card';
import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

export interface ImageRowData {
  id: string;
  thumbUrl: string;
  altUk: string | null;
  altEn: string | null;
  colorId: string | null;
  sortOrder: number;
  width: number | null;
  height: number | null;
}

const field = 'min-h-11 w-full rounded-md border border-border bg-surface px-2';
/** What the server refuses, by its answer code (a code is never shown as is). */
const UPLOAD_ERRORS = [
  'TOO_LARGE',
  'IMAGE_UNSUPPORTED_TYPE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_ANIMATED',
  'IMAGE_UNREADABLE',
  'ADMIN_TOO_MANY_IMAGES',
  'MEDIA_NOT_CONFIGURED',
  'RATE_LIMITED',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'STORAGE_FAILED',
] as const;

function ImageLine({
  image,
  colors,
  canEdit,
}: {
  image: ImageRowData;
  colors: readonly { id: string; name: string }[];
  canEdit: boolean;
}) {
  const t = useTranslations('admin.media');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const formId = `image-${image.id}`;
  const missingAlt = (image.altUk ?? '') === '' || (image.altEn ?? '') === '';
  return (
    <li className="flex flex-wrap gap-4 rounded-md border border-border p-3">
      <Image
        src={image.thumbUrl}
        alt={image.altUk ?? ''}
        width={160}
        height={
          image.width !== null && image.height !== null
            ? Math.round((160 * image.height) / image.width)
            : 160
        }
        unoptimized
        className="h-auto w-40 rounded-md"
      />
      <form
        id={formId}
        className="min-w-64 flex-1 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const data = readForm(event.currentTarget);
          setMessage(null);
          const color = textOf(data, 'colorId');
          run(
            async () =>
              await updateProductImageAction({
                imageId: image.id,
                altUk: textOf(data, 'altUk'),
                altEn: textOf(data, 'altEn'),
                colorId: color === '' ? null : color,
                sortOrder: Number(textOf(data, 'sortOrder')),
              }),
            t('saved'),
            () => {
              router.refresh();
            },
          );
        }}
      >
        {missingAlt ? (
          <p role="status" className="font-medium text-danger">
            {t('missingAlt')}
          </p>
        ) : null}
        <label className="block">
          {t('altUk')}
          <input
            name="altUk"
            defaultValue={image.altUk ?? ''}
            maxLength={300}
            readOnly={!canEdit}
            className={field}
          />
        </label>
        <label className="block">
          {t('altEn')}
          <input
            name="altEn"
            defaultValue={image.altEn ?? ''}
            maxLength={300}
            readOnly={!canEdit}
            className={field}
          />
        </label>
        <label className="block">
          {t('color')}
          <select
            name="colorId"
            defaultValue={image.colorId ?? ''}
            disabled={!canEdit}
            className={field}
          >
            <option value="">{t('anyColor')}</option>
            {colors.map((color) => (
              <option key={color.id} value={color.id}>
                {color.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          {t('order')}
          <input
            name="sortOrder"
            type="number"
            min={0}
            max={1000}
            defaultValue={image.sortOrder}
            readOnly={!canEdit}
            className={`${field} w-28`}
          />
        </label>
        {canEdit ? (
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={pending} className={buttonClass}>
              {t('save')}
            </button>
            <button
              type="button"
              disabled={pending}
              className="min-h-11 min-w-11 rounded-md border border-border px-3"
              onClick={() => {
                if (!window.confirm(t('confirmDelete'))) return;
                run(
                  async () => await deleteProductImageAction({ imageId: image.id }),
                  t('deleted'),
                  () => {
                    router.refresh();
                  },
                );
              }}
            >
              {t('delete')}
            </button>
          </div>
        ) : null}
        <StatusLine message={message} />
      </form>
    </li>
  );
}

export function ImagesPanel({
  productId,
  images,
  colors,
  canEdit,
}: {
  productId: string;
  images: readonly ImageRowData[];
  colors: readonly { id: string; name: string }[];
  canEdit: boolean;
}) {
  const t = useTranslations('admin.media');
  const errors = useTranslations('admin.media.errors');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList): Promise<void> {
    setBusy(true);
    setStatus(null);
    let done = 0;
    for (const file of Array.from(files)) {
      const response = await fetch(
        `/admin/upload/product-image?productId=${encodeURIComponent(productId)}`,
        {
          method: 'POST',
          body: file,
          credentials: 'same-origin',
        },
      ).catch(() => null);
      if (response?.ok === true) {
        done += 1;
        continue;
      }
      const body: unknown = await response?.json().catch(() => null);
      const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : null;
      const known = UPLOAD_ERRORS.find((candidate) => candidate === code) ?? 'GENERIC';
      setStatus({
        kind: 'error',
        text: `${file.name}: ${known === 'GENERIC' ? t('failed') : errors(known)}`,
      });
      break;
    }
    if (done > 0)
      setStatus((current) => current ?? { kind: 'ok', text: t('uploaded', { count: done }) });
    setBusy(false);
    if (input.current !== null) input.current.value = '';
    router.refresh();
  }

  const missing = images.filter(
    (image) => (image.altUk ?? '') === '' || (image.altEn ?? '') === '',
  ).length;
  return (
    <section aria-labelledby="media" className="max-w-4xl space-y-4">
      <h2 id="media" className="text-lg font-semibold">
        {t('title')}
      </h2>
      {missing > 0 ? (
        <p role="status" className="text-danger">
          {t('missingAltCount', { count: missing })}
        </p>
      ) : null}
      {images.length === 0 ? (
        <p>{t('none')}</p>
      ) : (
        <ul className="space-y-3">
          {images.map((image) => (
            <ImageLine key={image.id} image={image} colors={colors} canEdit={canEdit} />
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="space-y-2">
          <label className="block">
            {t('add')}
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={busy}
              className={field}
              onChange={(event) => {
                if (event.currentTarget.files !== null && event.currentTarget.files.length > 0)
                  void upload(event.currentTarget.files);
              }}
            />
          </label>
          <p className="text-sm text-text-muted">{t('hint')}</p>
          <StatusLine message={status} />
        </div>
      ) : null}
    </section>
  );
}
