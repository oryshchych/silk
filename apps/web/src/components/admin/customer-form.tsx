'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { updateCustomerAction } from '@/actions/admin-customers';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const field = 'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3';

/** Tags (space separated) and the internal note of one customer. */
export function CustomerForm(props: { customerKey: string; tags: string[]; note: string | null }) {
  const t = useTranslations('admin.customers');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        setMessage(null);
        run(
          async () =>
            await updateCustomerAction({
              key: props.customerKey,
              tags: textOf(data, 'tags')
                .split(/\s+/)
                .filter((tag) => tag !== ''),
              note: textOf(data, 'note'),
            }),
          t('saved'),
          () => {
            router.refresh();
          },
        );
      }}
    >
      <label className="block">
        {t('tagsLabel')}
        <input name="tags" defaultValue={props.tags.join(' ')} maxLength={400} className={field} />
        <span className="mt-1 block text-sm text-text-muted">{t('tagsHint')}</span>
      </label>
      <label className="block">
        {t('noteLabel')}
        <textarea
          name="note"
          defaultValue={props.note ?? ''}
          maxLength={1000}
          rows={3}
          className={`${field} py-2`}
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60"
      >
        {t('save')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
