import { can } from '@store/core/auth-permissions';
import { getReturn } from '@store/core/returns-admin';
import { formatMoney } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { ReturnActions } from '@/components/admin/return-actions';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function AdminReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('returns.manage');
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const db = await getDb();
  const dto = await getReturn(db, parsed.data);
  if (dto === null) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.returns' });
  return (
    <div className="flex flex-col gap-4">
      <a href="/admin/returns" className="inline-flex min-h-11 items-center underline">
        {t('back')}
      </a>
      <h1 className="text-2xl font-semibold">
        {dto.requestNumber} · {t(`status.${dto.status}`)}
      </h1>
      <p className="text-sm text-text-muted">
        {dto.orderNumber} · {dto.customerEmail ?? ''} · {t(`reason.${dto.reason}`)} ·{' '}
        {dto.policyVersion}
      </p>
      {dto.customerComment === null ? null : (
        <p className="whitespace-pre-line">{dto.customerComment}</p>
      )}
      <ul className="flex flex-col gap-1 text-sm">
        {dto.items.map((item) => (
          <li key={item.id}>
            {item.name} ({item.sizeLabel}): {t('requested')} {item.quantity}, {t('received')}{' '}
            {item.receivedQuantity}, {t('restocked')} {item.restockedQuantity}
          </li>
        ))}
      </ul>
      <p>
        {t('suggested')}: {formatMoney(dto.suggestedRefund, locale)}
        {dto.refundAmount === null
          ? ''
          : ` · ${t('agreed')}: ${formatMoney(dto.refundAmount, locale)}`}
        {dto.refundState === null ? '' : ` · ${t('refundState')}: ${dto.refundState}`}
      </p>
      <ReturnActions
        view={{
          id: dto.id,
          status: dto.status,
          reason: dto.reason,
          refundState: dto.refundState,
          items: dto.items,
        }}
        canRefund={can(session.role, 'orders.refund')}
      />
    </div>
  );
}
