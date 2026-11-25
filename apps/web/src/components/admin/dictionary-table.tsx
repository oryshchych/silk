'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { buttonClass } from './auth-card';
import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction, type ActionOutcome } from './use-admin-action';

type ColumnKind = 'text' | 'number' | 'color' | 'select' | 'checkbox';

export interface Column {
  name: string;
  label: string;
  kind: ColumnKind;
  maxLength?: number;
  required?: boolean;
  options?: readonly { value: string; label: string }[];
}

export type RowValues = Record<string, string | boolean>;

const input = 'min-h-11 w-full min-w-24 rounded-md border border-border bg-surface px-2';

function Control({
  column,
  form,
  id,
  value,
  readOnly,
}: {
  column: Column;
  form: string;
  id: string;
  value: string | boolean | undefined;
  readOnly: boolean;
}) {
  if (column.kind === 'checkbox') {
    return (
      <input
        id={id}
        form={form}
        name={column.name}
        type="checkbox"
        defaultChecked={value === true}
        disabled={readOnly}
        className="size-5"
      />
    );
  }
  if (column.kind === 'select') {
    return (
      <select
        id={id}
        form={form}
        name={column.name}
        defaultValue={typeof value === 'string' ? value : ''}
        disabled={readOnly}
        className={input}
      >
        {(column.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      form={form}
      name={column.name}
      type={column.kind === 'color' ? 'color' : column.kind === 'number' ? 'number' : 'text'}
      defaultValue={typeof value === 'string' ? value : ''}
      readOnly={readOnly}
      required={column.required}
      maxLength={column.maxLength}
      className={
        column.kind === 'color' ? 'h-11 w-16 rounded-md border border-border bg-surface' : input
      }
    />
  );
}

function valuesOf(data: FormData, columns: readonly Column[]): RowValues {
  return Object.fromEntries(
    columns.map((column) => [
      column.name,
      column.kind === 'checkbox' ? data.get(column.name) !== null : textOf(data, column.name),
    ]),
  );
}

function Line({
  rowId,
  values,
  columns,
  canEdit,
  onSave,
}: {
  rowId: string;
  values: RowValues;
  columns: readonly Column[];
  canEdit: boolean;
  onSave: (id: string, values: RowValues) => Promise<ActionOutcome>;
}) {
  const t = useTranslations('admin.taxonomy');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const formId = `row-${rowId}`;
  return (
    <tr className="border-b border-border align-top">
      {columns.map((column, index) => (
        <td key={column.name} className="px-2 py-2">
          {index === 0 ? (
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                setMessage(null);
                const next = valuesOf(readForm(event.currentTarget), columns);
                run(
                  async () => await onSave(rowId, next),
                  t('saved'),
                  () => {
                    router.refresh();
                  },
                );
              }}
            />
          ) : null}
          <label className="sr-only" htmlFor={`${formId}-${column.name}`}>
            {column.label}
          </label>
          <Control
            column={column}
            form={formId}
            id={`${formId}-${column.name}`}
            value={values[column.name]}
            readOnly={!canEdit}
          />
        </td>
      ))}
      <td className="px-2 py-2">
        {canEdit ? (
          <>
            <button
              type="submit"
              form={formId}
              disabled={pending}
              className="min-h-11 min-w-11 rounded-md border border-border px-3"
            >
              {t('save')}
            </button>
            <StatusLine message={message} />
          </>
        ) : null}
      </td>
    </tr>
  );
}

/** A list of rows that can be edited in place, plus a form to add one. Every save is a server action. */
export function DictionaryTable({
  title,
  columns,
  rows,
  canEdit,
  onSave,
  onCreate,
  createDefaults,
}: {
  title: string;
  columns: readonly Column[];
  rows: readonly { id: string; values: RowValues }[];
  canEdit: boolean;
  onSave: (id: string, values: RowValues) => Promise<ActionOutcome>;
  onCreate: (values: RowValues) => Promise<ActionOutcome>;
  createDefaults?: RowValues;
}) {
  const t = useTranslations('admin.taxonomy');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const header = 'px-2 py-2 text-left font-medium';
  return (
    <section aria-label={title} className="space-y-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => (
                <th key={column.name} scope="col" className={header}>
                  {column.label}
                </th>
              ))}
              <th scope="col" className={header}>
                <span className="sr-only">{t('save')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Line
                key={row.id}
                rowId={row.id}
                values={row.values}
                columns={columns}
                canEdit={canEdit}
                onSave={onSave}
              />
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            setMessage(null);
            const values = valuesOf(readForm(form), columns);
            run(
              async () => await onCreate(values),
              t('saved'),
              () => {
                form.reset();
                router.refresh();
              },
            );
          }}
          className="grid max-w-3xl gap-3 sm:grid-cols-2"
        >
          {columns.map((column) => (
            <label key={column.name} className="block">
              {column.label}
              <Control
                column={column}
                form=""
                id={`new-${title}-${column.name}`}
                value={createDefaults?.[column.name]}
                readOnly={false}
              />
            </label>
          ))}
          <div className="sm:col-span-2">
            <StatusLine message={message} />
            <button type="submit" disabled={pending} className={buttonClass}>
              {t('create')}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
