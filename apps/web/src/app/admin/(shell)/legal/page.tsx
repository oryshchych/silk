import { listLegalDocuments } from '@store/core/legal';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { LegalCreateForm } from '@/components/admin/legal-create-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

/** Every version of every legal document. Reading needs `legal.edit` (drafts are not public). */
export default async function AdminLegalPage() {
  await requirePermission('legal.edit');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.legal' });
  const docs = await listLegalDocuments(await getDb());
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('heading')}</h1>
      <p role="note" className="max-w-3xl rounded-md border border-border p-3 text-sm">
        {t('lawyerNotice')}
      </p>
      {docs.length === 0 ? <p>{t('empty')}</p> : null}
      <table className="w-full max-w-4xl text-left">
        <caption className="sr-only">{t('heading')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('kind')}</th>
            <th scope="col">{t('locale')}</th>
            <th scope="col">{t('version')}</th>
            <th scope="col">{t('statusLabel')}</th>
            <th scope="col">{t('effectiveFrom')}</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => (
            <tr key={doc.id} className="border-t border-border">
              <td className="py-2">
                <a
                  href={`/admin/legal/${doc.id}`}
                  className="inline-flex min-h-11 items-center underline"
                >
                  {t(`kinds.${doc.kind}`)}
                </a>
              </td>
              <td>{doc.locale}</td>
              <td>{doc.version}</td>
              <td>
                {t(`status.${doc.status}`)}
                {doc.isCurrent ? ` · ${t('current')}` : ''}
              </td>
              <td>{doc.effectiveFrom.slice(0, 16).replace('T', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section aria-labelledby="new-draft" className="flex flex-col gap-3">
        <h2 id="new-draft" className="text-lg font-semibold">
          {t('newDraft')}
        </h2>
        <LegalCreateForm />
      </section>
    </div>
  );
}
