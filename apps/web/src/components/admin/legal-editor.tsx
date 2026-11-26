'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import {
  createLegalDraftAction,
  deleteLegalDraftAction,
  publishLegalAction,
  removeLegalFileAction,
  updateLegalDraftAction,
} from '@/actions/admin-legal';
import type { AdminLegalDto } from '@store/shared/dto/legal';

import { buttonClass } from './auth-card';
import { StatusLine, TextArea, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const UPLOAD_ERRORS = [
  'TOO_LARGE',
  'PDF_UNSUPPORTED_TYPE',
  'MEDIA_NOT_CONFIGURED',
  'RATE_LIMITED',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'STORAGE_FAILED',
  'LEGAL_NOT_DRAFT',
  'LEGAL_NOT_FOUND',
  'BUSY',
  'TIMEOUT',
] as const;

const FIELD = { title: 'title', source: 'source', start: 'effectiveFrom' } as const;

/** `datetime-local` value (local time) for an ISO instant. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One version of a legal document. A draft is edited, given a PDF, published (`legal.publish` only) or
 * deleted. A published version is read-only: the way to change it is a new version, started from its text.
 * The text is Markdown (a small subset); the server renders and sanitises it, and the public page
 * sanitises again.
 */
export function LegalEditor({ doc, canPublish }: { doc: AdminLegalDto; canPublish: boolean }) {
  const t = useTranslations('admin.legal');
  const uploadErrors = useTranslations('admin.legal.uploadErrors');
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const draft = doc.status === 'draft';
  const secondary = 'min-h-11 rounded-md border border-border px-4 disabled:opacity-60';

  async function sendPdf(file: File): Promise<void> {
    setUpload(null);
    const response = await fetch(`/admin/upload/legal-pdf?id=${encodeURIComponent(doc.id)}`, {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
    }).catch(() => null);
    if (response?.ok === true) {
      setUpload({ kind: 'ok', text: t('pdfUploaded') });
    } else {
      const body: unknown = await response?.json().catch(() => null);
      const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : null;
      const known = UPLOAD_ERRORS.find((candidate) => candidate === code);
      setUpload({
        kind: 'error',
        text: known === undefined ? t('pdfFailed') : uploadErrors(known),
      });
    }
    if (fileInput.current !== null) fileInput.current.value = '';
    router.refresh();
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p role="note" className="rounded-md border border-border p-3 text-sm">
        {t('lawyerNotice')}
      </p>
      <p>
        {t(`status.${doc.status}`)} · {t('versionLabel', { version: doc.version })}
        {doc.isCurrent ? ` · ${t('current')}` : ''}
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const data = readForm(event.currentTarget);
          const start = textOf(data, FIELD.start);
          run(
            async () =>
              await updateLegalDraftAction({
                id: doc.id,
                title: textOf(data, FIELD.title),
                source: textOf(data, FIELD.source),
                ...(start === '' ? {} : { effectiveFrom: new Date(start).toISOString() }),
              }),
            t('saved'),
            () => {
              router.refresh();
            },
          );
        }}
      >
        <fieldset disabled={!draft} className="flex flex-col gap-3">
          <TextField
            label={t('title')}
            name={FIELD.title}
            defaultValue={doc.title}
            maxLength={200}
            required
          />
          <label className="block">
            {t('effectiveFrom')}
            <input
              type="datetime-local"
              name={FIELD.start}
              defaultValue={toLocalInput(doc.effectiveFrom)}
              className="mt-1 block min-h-11 rounded-md border border-border bg-surface px-3"
            />
            <span className="mt-1 block text-sm text-text-muted">{t('effectiveHint')}</span>
          </label>
          <TextArea
            label={t('source')}
            name={FIELD.source}
            defaultValue={doc.bodySource}
            maxLength={100000}
            rows={20}
          />
          <p className="text-sm text-text-muted">{t('sourceHint')}</p>
        </fieldset>
        {draft ? (
          <button type="submit" disabled={pending} className={`${buttonClass} w-fit`}>
            {t('save')}
          </button>
        ) : null}
      </form>

      <section aria-labelledby="legal-pdf" className="flex flex-col gap-2">
        <h2 id="legal-pdf" className="text-lg font-semibold">
          {t('pdf')}
        </h2>
        {doc.fileUrl === null ? (
          <p>{t('noPdf')}</p>
        ) : (
          <p>
            <a href={doc.fileUrl} rel="noopener noreferrer" className="underline">
              {t('pdfLink')}
            </a>
          </p>
        )}
        {draft ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="block">
              {t('pdfChoose')}
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf"
                className="mt-1 block"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file !== undefined) void sendPdf(file);
                }}
              />
            </label>
            {doc.fileUrl === null ? null : (
              <button
                type="button"
                disabled={pending}
                className={secondary}
                onClick={() => {
                  run(
                    async () => await removeLegalFileAction({ id: doc.id }),
                    t('pdfRemoved'),
                    () => {
                      router.refresh();
                    },
                  );
                }}
              >
                {t('pdfRemove')}
              </button>
            )}
          </div>
        ) : null}
        <StatusLine message={upload} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {draft && canPublish ? (
          <button
            type="button"
            disabled={pending}
            className={buttonClass}
            onClick={() => {
              if (!window.confirm(t('confirmPublish'))) return;
              run(
                async () => await publishLegalAction({ id: doc.id }),
                t('published'),
                () => {
                  router.refresh();
                },
              );
            }}
          >
            {t('publish')}
          </button>
        ) : null}
        {draft && !canPublish ? (
          <p className="text-sm text-text-muted">{t('needsPublisher')}</p>
        ) : null}
        {draft && canPublish ? (
          <button
            type="button"
            disabled={pending}
            className={secondary}
            onClick={() => {
              if (!window.confirm(t('confirmDelete'))) return;
              run(
                async () => await deleteLegalDraftAction({ id: doc.id }),
                t('deleted'),
                () => {
                  router.push('/admin/legal');
                },
              );
            }}
          >
            {t('delete')}
          </button>
        ) : null}
        {draft ? null : (
          <button
            type="button"
            disabled={pending}
            className={buttonClass}
            onClick={() => {
              run(
                async () =>
                  await createLegalDraftAction({
                    kind: doc.kind,
                    locale: doc.locale,
                    title: doc.title,
                    source: doc.bodySource ?? '',
                  }),
                t('created'),
                () => {
                  router.push('/admin/legal');
                },
              );
            }}
          >
            {t('newVersion')}
          </button>
        )}
      </div>
      <StatusLine message={message} />
    </div>
  );
}
