'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { createLegalDraftAction } from '@/actions/admin-legal';
import { LEGAL_KINDS, LEGAL_LOCALES } from '@store/shared/legal';

import { buttonClass } from './auth-card';
import { CheckField, SelectField, StatusLine, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

/** A new draft of a document in a language: the number of the version is assigned by the server. */
const FIELD = { kind: 'kind', locale: 'locale', title: 'title', template: 'template' } as const;

export function LegalCreateForm() {
  const t = useTranslations('admin.legal');
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  return (
    <form
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        run(
          async () =>
            await createLegalDraftAction({
              kind: textOf(data, FIELD.kind),
              locale: textOf(data, FIELD.locale),
              title: textOf(data, FIELD.title),
              source: '',
              fromTemplate: data.get(FIELD.template) === 'on',
            }),
          t('created'),
          () => {
            router.refresh();
          },
        );
      }}
    >
      <SelectField
        label={t('kind')}
        name={FIELD.kind}
        options={LEGAL_KINDS.map((kind) => ({ value: kind, label: t(`kinds.${kind}`) }))}
      />
      <SelectField
        label={t('locale')}
        name={FIELD.locale}
        options={LEGAL_LOCALES.map((locale) => ({ value: locale, label: t(`locales.${locale}`) }))}
      />
      <CheckField label={t('fromTemplate')} name={FIELD.template} />
      <TextField label={t('title')} name={FIELD.title} maxLength={200} required />
      <button type="submit" disabled={pending} className={`${buttonClass} w-fit`}>
        {t('create')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
