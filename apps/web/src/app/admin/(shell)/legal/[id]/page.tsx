import { can } from '@store/core/auth-permissions';
import { getLegalDocumentAdmin, LegalNotFoundError } from '@store/core/legal';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { LegalEditor } from '@/components/admin/legal-editor';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function AdminLegalDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('legal.edit');
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const doc = await getLegalDocumentAdmin(await getDb(), parsed.data).catch((error: unknown) => {
    if (error instanceof LegalNotFoundError) return null;
    throw error;
  });
  if (doc === null) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.legal' });
  return (
    <div className="flex flex-col gap-4">
      <a href="/admin/legal" className="inline-flex min-h-11 items-center underline">
        {t('back')}
      </a>
      <h1 className="text-2xl font-semibold">
        {t(`kinds.${doc.kind}`)} · {doc.locale}
      </h1>
      <LegalEditor doc={doc} canPublish={can(session.role, 'legal.publish')} />
    </div>
  );
}
