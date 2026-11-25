'use client';

import { useTranslations } from 'next-intl';

import {
  saveAttributeAction,
  saveAttributeValueAction,
  saveColorAction,
  saveSizeAction,
} from '@/actions/admin-taxonomy';

import { DictionaryTable, type Column, type RowValues } from './dictionary-table';
import type { ActionOutcome } from './use-admin-action';

export interface ColorData {
  id: string;
  slug: string;
  nameUk: string;
  nameEn: string;
  hex: string;
  sortOrder: number;
}
export interface SizeData {
  id: string;
  system: string;
  label: string;
  band: number | null;
  cup: string | null;
  euLabel: string | null;
  usLabel: string | null;
  sortOrder: number;
}
export interface AttributeData {
  id: string;
  code: string;
  nameUk: string;
  nameEn: string;
  type: string;
  isFilterable: boolean;
  sortOrder: number;
  values: { id: string; slug: string; valueUk: string; valueEn: string; sortOrder: number }[];
}

const str = (value: string | boolean | undefined): string =>
  typeof value === 'string' ? value : '';
const num = (value: string | boolean | undefined): number => Number(str(value) || '0');
const orNull = (value: string | boolean | undefined): string | null =>
  str(value).trim() === '' ? null : str(value);

export function DictionariesPanel({
  colors,
  sizes,
  attributes,
  canEdit,
}: {
  colors: readonly ColorData[];
  sizes: readonly SizeData[];
  attributes: readonly AttributeData[];
  canEdit: boolean;
}) {
  const t = useTranslations('admin.taxonomy');
  const colorColumns: Column[] = [
    { name: 'nameUk', label: t('nameUk'), kind: 'text', maxLength: 80, required: true },
    { name: 'nameEn', label: t('nameEn'), kind: 'text', maxLength: 80, required: true },
    { name: 'slug', label: t('slug'), kind: 'text', maxLength: 80, required: true },
    { name: 'hex', label: t('hex'), kind: 'color' },
    { name: 'sortOrder', label: t('order'), kind: 'number' },
  ];
  const systems = ['bra', 'panty', 'apparel', 'onesize'].map((value) => ({ value, label: value }));
  const sizeColumns: Column[] = [
    { name: 'system', label: t('system'), kind: 'select', options: systems },
    { name: 'label', label: t('label'), kind: 'text', maxLength: 20, required: true },
    { name: 'band', label: t('band'), kind: 'number' },
    { name: 'cup', label: t('cup'), kind: 'text', maxLength: 4 },
    { name: 'euLabel', label: t('eu'), kind: 'text', maxLength: 20 },
    { name: 'usLabel', label: t('us'), kind: 'text', maxLength: 20 },
    { name: 'sortOrder', label: t('order'), kind: 'number' },
  ];
  const types = ['select', 'multiselect', 'boolean', 'text'].map((value) => ({
    value,
    label: value,
  }));
  const attributeColumns: Column[] = [
    { name: 'code', label: t('code'), kind: 'text', maxLength: 64, required: true },
    { name: 'nameUk', label: t('nameUk'), kind: 'text', maxLength: 120, required: true },
    { name: 'nameEn', label: t('nameEn'), kind: 'text', maxLength: 120, required: true },
    { name: 'type', label: t('type'), kind: 'select', options: types },
    { name: 'isFilterable', label: t('filterable'), kind: 'checkbox' },
    { name: 'sortOrder', label: t('order'), kind: 'number' },
  ];
  const valueColumns: Column[] = [
    { name: 'valueUk', label: t('valueUk'), kind: 'text', maxLength: 160, required: true },
    { name: 'valueEn', label: t('valueEn'), kind: 'text', maxLength: 160, required: true },
    { name: 'slug', label: t('slug'), kind: 'text', maxLength: 80, required: true },
    { name: 'sortOrder', label: t('order'), kind: 'number' },
  ];

  const colorBody = (v: RowValues) => ({
    slug: str(v['slug']),
    nameUk: str(v['nameUk']),
    nameEn: str(v['nameEn']),
    hex: str(v['hex']),
    sortOrder: num(v['sortOrder']),
  });
  const sizeBody = (v: RowValues) => ({
    system: str(v['system']),
    label: str(v['label']),
    band: orNull(v['band']) === null ? null : num(v['band']),
    cup: orNull(v['cup']),
    euLabel: orNull(v['euLabel']),
    usLabel: orNull(v['usLabel']),
    sortOrder: num(v['sortOrder']),
  });
  const attributeBody = (v: RowValues) => ({
    code: str(v['code']),
    nameUk: str(v['nameUk']),
    nameEn: str(v['nameEn']),
    type: str(v['type']),
    isFilterable: v['isFilterable'] === true,
    sortOrder: num(v['sortOrder']),
  });
  const valueBody = (attributeId: string, v: RowValues) => ({
    attributeId,
    slug: str(v['slug']),
    valueUk: str(v['valueUk']),
    valueEn: str(v['valueEn']),
    sortOrder: num(v['sortOrder']),
  });
  const done = (result: ActionOutcome): ActionOutcome => result;

  return (
    <div className="space-y-12">
      <DictionaryTable
        title={t('colors')}
        columns={colorColumns}
        canEdit={canEdit}
        createDefaults={{ sortOrder: '0' }}
        rows={colors.map((c) => ({ id: c.id, values: { ...c, sortOrder: String(c.sortOrder) } }))}
        onSave={async (id, v) => done(await saveColorAction({ colorId: id, ...colorBody(v) }))}
        onCreate={async (v) => done(await saveColorAction(colorBody(v)))}
      />
      <DictionaryTable
        title={t('sizes')}
        columns={sizeColumns}
        canEdit={canEdit}
        createDefaults={{ sortOrder: '0' }}
        rows={sizes.map((s) => ({
          id: s.id,
          values: {
            system: s.system,
            label: s.label,
            band: s.band === null ? '' : String(s.band),
            cup: s.cup ?? '',
            euLabel: s.euLabel ?? '',
            usLabel: s.usLabel ?? '',
            sortOrder: String(s.sortOrder),
          },
        }))}
        onSave={async (id, v) => done(await saveSizeAction({ sizeId: id, ...sizeBody(v) }))}
        onCreate={async (v) => done(await saveSizeAction(sizeBody(v)))}
      />
      <DictionaryTable
        title={t('attributes')}
        columns={attributeColumns}
        canEdit={canEdit}
        createDefaults={{ isFilterable: true, sortOrder: '0' }}
        rows={attributes.map((a) => ({
          id: a.id,
          values: {
            code: a.code,
            nameUk: a.nameUk,
            nameEn: a.nameEn,
            type: a.type,
            isFilterable: a.isFilterable,
            sortOrder: String(a.sortOrder),
          },
        }))}
        onSave={async (id, v) =>
          done(await saveAttributeAction({ attributeId: id, ...attributeBody(v) }))
        }
        onCreate={async (v) => done(await saveAttributeAction(attributeBody(v)))}
      />
      {attributes.map((attribute) => (
        <DictionaryTable
          key={attribute.id}
          title={`${t('valuesOf')} ${attribute.nameUk}`}
          columns={valueColumns}
          canEdit={canEdit}
          createDefaults={{ sortOrder: '0' }}
          rows={attribute.values.map((value) => ({
            id: value.id,
            values: {
              valueUk: value.valueUk,
              valueEn: value.valueEn,
              slug: value.slug,
              sortOrder: String(value.sortOrder),
            },
          }))}
          onSave={async (id, v) =>
            done(await saveAttributeValueAction({ ...valueBody(attribute.id, v), valueId: id }))
          }
          onCreate={async (v) => done(await saveAttributeValueAction(valueBody(attribute.id, v)))}
        />
      ))}
    </div>
  );
}
