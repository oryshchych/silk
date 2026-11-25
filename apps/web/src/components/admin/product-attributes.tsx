'use client';

import { useTranslations } from 'next-intl';

import { setProductAttributesAction } from '@/actions/admin-taxonomy';

import { buttonClass } from './auth-card';
import { StatusLine } from './fields';
import { readForm, useAdminAction } from './use-admin-action';

export function ProductAttributes({
  productId,
  attributes,
  selected,
  canEdit,
}: {
  productId: string;
  attributes: readonly {
    id: string;
    name: string;
    values: readonly { id: string; label: string }[];
  }[];
  selected: readonly string[];
  canEdit: boolean;
}) {
  const t = useTranslations('admin.taxonomy');
  const { message, pending, run, setMessage } = useAdminAction();
  if (attributes.length === 0) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        setMessage(null);
        run(
          async () =>
            await setProductAttributesAction({
              productId,
              attributeValueIds: data
                .getAll('valueIds')
                .filter((v): v is string => typeof v === 'string'),
            }),
          t('saved'),
        );
      }}
      className="max-w-3xl space-y-3"
    >
      <h2 className="text-lg font-semibold">{t('productAttributes')}</h2>
      {attributes.map((attribute) => (
        <fieldset key={attribute.id} className="flex flex-wrap gap-x-4">
          <legend className="font-medium">{attribute.name}</legend>
          {attribute.values.map((value) => (
            <label key={value.id} className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                name="valueIds"
                value={value.id}
                defaultChecked={selected.includes(value.id)}
                disabled={!canEdit}
                className="size-5"
              />
              {value.label}
            </label>
          ))}
        </fieldset>
      ))}
      {canEdit ? (
        <>
          <StatusLine message={message} />
          <button type="submit" disabled={pending} className={buttonClass}>
            {t('save')}
          </button>
        </>
      ) : null}
    </form>
  );
}
