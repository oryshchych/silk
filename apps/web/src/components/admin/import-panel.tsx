'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { commitImportAction, previewImportAction } from '@/actions/admin-import';

import { buttonClass, fieldClass } from './auth-card';
import { StatusLine } from './fields';

/** UTF-8 BYTES: the server action's body passes through the proxy's 64 KB limit. */
const MAX_BYTES = 56_000;

interface Row {
  line: number;
  sku: string;
  action: 'create' | 'update' | 'error';
  errors: string[];
}

const ROW_ERRORS = [
  'sku_required',
  'sku_invalid',
  'sku_duplicate_in_file',
  'slug_invalid',
  'name_required',
  'brand_required',
  'category_required',
  'category_unknown',
  'price_required',
  'price_invalid',
  'compare_price_invalid',
  'cost_invalid',
  'weight_invalid',
  'text_too_long',
  'price_forbidden',
  'cost_forbidden',
  'row_too_short',
  'row_failed',
  'ADMIN_SLUG_TAKEN',
  'ADMIN_SKU_TAKEN',
  'ADMIN_INVALID_PRICE',
] as const;
const FILE_ERRORS = [
  'CSV_TOO_LARGE',
  'CSV_INVALID_CHARACTERS',
  'CSV_DUPLICATE_HEADER',
  'CSV_TOO_MANY_ROWS',
  'CSV_TOO_MANY_COLUMNS',
  'CSV_CELL_TOO_LONG',
  'CSV_UNTERMINATED_QUOTE',
  'CSV_EMPTY',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'INVALID_INPUT',
] as const;

type Phase =
  | { kind: 'idle' }
  | { kind: 'preview'; csv: string; rows: Row[]; ignored: string[] }
  | { kind: 'done'; rows: Row[]; created: number; updated: number; failed: number };

export function ImportPanel() {
  const t = useTranslations('admin.importExport');
  const rowErrors = useTranslations('admin.importExport.rowErrors');
  const fileErrors = useTranslations('admin.importExport.fileErrors');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const fileMessage = (code: string): string => {
    const known = FILE_ERRORS.find((candidate) => candidate === code);
    return known === undefined ? t('failed') : fileErrors(known);
  };
  const rowMessage = (code: string): string => {
    const known = ROW_ERRORS.find((candidate) => candidate === code);
    return known === undefined ? code : rowErrors(known);
  };

  function onFile(file: File | undefined): void {
    setMessage(null);
    setPhase({ kind: 'idle' });
    if (file === undefined) return;
    startTransition(async () => {
      if (file.size > MAX_BYTES) {
        setMessage({ kind: 'error', text: t('tooBig') });
        return;
      }
      const csv = await file.text();
      // A refusal by the platform (a body over the limit) is a thrown error, not an answer.
      const result = await previewImportAction({ csv }).catch(() => null);
      if (result === null) {
        setMessage({ kind: 'error', text: t('tooBig') });
        return;
      }
      if (!result.ok) {
        setMessage({ kind: 'error', text: fileMessage(result.code) });
        return;
      }
      setPhase({
        kind: 'preview',
        csv,
        rows: result.data.results,
        ignored: result.data.ignoredColumns,
      });
    });
  }

  function onCommit(csv: string): void {
    startTransition(async () => {
      const result = await commitImportAction({ csv }).catch(() => null);
      if (result === null) {
        setMessage({ kind: 'error', text: t('tooBig') });
        return;
      }
      if (!result.ok) {
        setMessage({ kind: 'error', text: fileMessage(result.code) });
        return;
      }
      setPhase({
        kind: 'done',
        rows: result.data.results,
        created: result.data.created,
        updated: result.data.updated,
        failed: result.data.failed,
      });
    });
  }

  const rows = phase.kind === 'idle' ? [] : phase.rows;
  const good = rows.filter((row) => row.action !== 'error').length;
  const bad = rows.length - good;
  const cell = 'px-3 py-2 align-top';
  return (
    <section aria-labelledby="import" className="max-w-4xl space-y-4">
      <h2 id="import" className="text-lg font-semibold">
        {t('importTitle')}
      </h2>
      <p className="text-text-muted">{t('importHint')}</p>
      <label className="block">
        {t('file')}
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={pending}
          className={fieldClass}
          onChange={(event) => {
            onFile(event.currentTarget.files?.[0]);
          }}
        />
      </label>
      <StatusLine message={message} />
      {phase.kind === 'preview' ? (
        <div className="space-y-3">
          <p role="status">{t('previewSummary', { good, bad })}</p>
          {phase.ignored.length > 0 ? (
            <p className="text-text-muted">{t('ignored', { columns: phase.ignored.join(', ') })}</p>
          ) : null}
          <button
            type="button"
            disabled={pending || good === 0}
            className={buttonClass}
            onClick={() => {
              onCommit(phase.csv);
            }}
          >
            {t('commit', { count: good })}
          </button>
        </div>
      ) : null}
      {phase.kind === 'done' ? (
        <p role="status" className="font-medium">
          {t('doneSummary', {
            created: phase.created,
            updated: phase.updated,
            failed: phase.failed,
          })}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t('importTitle')}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={`${cell} text-left`}>
                  {t('line')}
                </th>
                <th scope="col" className={`${cell} text-left`}>
                  {t('sku')}
                </th>
                <th scope="col" className={`${cell} text-left`}>
                  {t('result')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.line} className="border-b border-border">
                  <td className={cell}>{row.line}</td>
                  <td className={cell}>{row.sku}</td>
                  <td className={cell}>
                    {row.action === 'error' ? (
                      <span className="text-danger">{row.errors.map(rowMessage).join('; ')}</span>
                    ) : row.action === 'create' ? (
                      t('willCreate')
                    ) : (
                      t('willUpdate')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
