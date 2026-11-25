'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import {
  createCategoryAction,
  moveCategoryAction,
  updateCategoryAction,
} from '@/actions/admin-taxonomy';

import { buttonClass } from './auth-card';
import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

export interface CategoryRowData {
  id: string;
  parentId: string | null;
  slug: string;
  nameUk: string;
  nameEn: string;
  depth: number;
  sortOrder: number;
  isActive: boolean;
}

const input = 'min-h-11 w-full min-w-28 rounded-md border border-border bg-surface px-2';

function ParentSelect({
  id,
  all,
  current,
  self,
  label,
  form,
}: {
  id: string;
  all: readonly CategoryRowData[];
  current: string | null;
  self: string | null;
  label: string;
  form?: string;
}) {
  const t = useTranslations('admin.taxonomy');
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <select id={id} form={form} name="parentId" defaultValue={current ?? ''} className={input}>
        <option value="">{t('root')}</option>
        {all
          .filter((category) => category.id !== self)
          .map((category) => (
            <option key={category.id} value={category.id}>
              {`${'— '.repeat(category.depth)}${category.nameUk}`}
            </option>
          ))}
      </select>
    </>
  );
}

function CategoryLine({
  row,
  all,
  canEdit,
}: {
  row: CategoryRowData;
  all: readonly CategoryRowData[];
  canEdit: boolean;
}) {
  const t = useTranslations('admin.taxonomy');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const formId = `category-${row.id}`;
  return (
    <tr className="border-b border-border align-top">
      <td className="px-2 py-2">
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            setMessage(null);
            run(
              async () => {
                const parent = textOf(data, 'parentId');
                const wanted = parent === '' ? null : parent;
                if (
                  wanted !== row.parentId ||
                  Number(textOf(data, 'sortOrder')) !== row.sortOrder
                ) {
                  const moved = await moveCategoryAction({
                    categoryId: row.id,
                    parentId: wanted,
                    sortOrder: Number(textOf(data, 'sortOrder')),
                  });
                  if (!moved.ok) return moved;
                }
                return await updateCategoryAction({
                  categoryId: row.id,
                  slug: textOf(data, 'slug'),
                  nameUk: textOf(data, 'nameUk'),
                  nameEn: textOf(data, 'nameEn'),
                  isActive: data.get('isActive') !== null,
                });
              },
              t('saved'),
              () => {
                router.refresh();
              },
            );
          }}
        >
          <label className="sr-only" htmlFor={`${formId}-uk`}>
            {t('nameUk')} {row.nameUk}
          </label>
          <input
            id={`${formId}-uk`}
            name="nameUk"
            defaultValue={row.nameUk}
            readOnly={!canEdit}
            required
            maxLength={200}
            className={input}
            style={{ paddingLeft: `${String(0.5 + row.depth * 1.25)}rem` }}
          />
        </form>
      </td>
      <td className="px-2 py-2">
        <label className="sr-only" htmlFor={`${formId}-en`}>
          {t('nameEn')} {row.nameUk}
        </label>
        <input
          id={`${formId}-en`}
          form={formId}
          name="nameEn"
          defaultValue={row.nameEn}
          readOnly={!canEdit}
          required
          maxLength={200}
          className={input}
        />
      </td>
      <td className="px-2 py-2">
        <label className="sr-only" htmlFor={`${formId}-slug`}>
          {t('slug')} {row.nameUk}
        </label>
        <input
          id={`${formId}-slug`}
          form={formId}
          name="slug"
          defaultValue={row.slug}
          readOnly={!canEdit}
          required
          maxLength={160}
          className={input}
        />
      </td>
      <td className="px-2 py-2">
        <ParentSelect
          id={`${formId}-parent`}
          all={all}
          current={row.parentId}
          self={row.id}
          label={`${t('parent')} ${row.nameUk}`}
          form={formId}
        />
      </td>
      <td className="px-2 py-2">
        <label className="sr-only" htmlFor={`${formId}-order`}>
          {t('order')} {row.nameUk}
        </label>
        <input
          id={`${formId}-order`}
          form={formId}
          name="sortOrder"
          type="number"
          min={0}
          max={100000}
          defaultValue={row.sortOrder}
          readOnly={!canEdit}
          className={`${input} w-24`}
        />
      </td>
      <td className="px-2 py-2">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            form={formId}
            name="isActive"
            defaultChecked={row.isActive}
            disabled={!canEdit}
            className="size-5"
          />
          <span className="sr-only">
            {t('active')} {row.nameUk}
          </span>
        </label>
      </td>
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

export function CategoriesPanel({
  rows,
  canEdit,
}: {
  rows: readonly CategoryRowData[];
  canEdit: boolean;
}) {
  const t = useTranslations('admin.taxonomy');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const header = 'px-2 py-2 text-left font-medium';
  return (
    <div className="space-y-8">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">{t('categories')}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={header}>
                {t('nameUk')}
              </th>
              <th scope="col" className={header}>
                {t('nameEn')}
              </th>
              <th scope="col" className={header}>
                {t('slug')}
              </th>
              <th scope="col" className={header}>
                {t('parent')}
              </th>
              <th scope="col" className={header}>
                {t('order')}
              </th>
              <th scope="col" className={header}>
                {t('active')}
              </th>
              <th scope="col" className={header}>
                <span className="sr-only">{t('save')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CategoryLine key={row.id} row={row} all={rows} canEdit={canEdit} />
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = readForm(form);
            setMessage(null);
            const parent = textOf(data, 'parentId');
            run(
              async () =>
                await createCategoryAction({
                  parentId: parent === '' ? null : parent,
                  slug: textOf(data, 'slug'),
                  nameUk: textOf(data, 'nameUk'),
                  nameEn: textOf(data, 'nameEn'),
                }),
              t('saved'),
              () => {
                form.reset();
                router.refresh();
              },
            );
          }}
          className="max-w-xl space-y-3"
        >
          <h2 className="text-lg font-semibold">{t('newCategory')}</h2>
          <label className="block">
            {t('nameUk')}
            <input name="nameUk" required maxLength={200} className={input} />
          </label>
          <label className="block">
            {t('nameEn')}
            <input name="nameEn" required maxLength={200} className={input} />
          </label>
          <label className="block">
            {t('slug')}
            <input name="slug" required maxLength={160} className={input} />
          </label>
          <label className="block">
            {t('parent')}
            <ParentSelect
              id="new-parent"
              all={rows}
              current={null}
              self={null}
              label={t('parent')}
            />
          </label>
          <StatusLine message={message} />
          <button type="submit" disabled={pending} className={buttonClass}>
            {t('create')}
          </button>
        </form>
      ) : null}
    </div>
  );
}
