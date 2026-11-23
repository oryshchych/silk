import { getTranslations } from 'next-intl/server';

import type { ListingParams } from '@store/core/catalog';
import type { FilterOptionsDto } from '@store/shared/dto/catalog';

/** Query parameter names, shared with `parseListingParams`. */
const FIELD = { band: 'band', cup: 'cup', size: 'size', color: 'color', brand: 'brand' } as const;

const SORT_OPTIONS = [
  ['newest', 'sortNewest'],
  ['price_asc', 'sortPriceAsc'],
  ['price_desc', 'sortPriceDesc'],
  ['discount', 'sortDiscount'],
] as const;

function Group({
  legend,
  name,
  options,
  selected,
}: {
  legend: string;
  name: string;
  options: readonly { value: string; label: string }[];
  selected: readonly string[];
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-1 border-t border-border pt-3">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="flex min-h-6 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name={name}
            value={option.value}
            defaultChecked={selected.includes(option.value)}
            className="size-4"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Filters and sorting as a plain GET form: the URL is the only state
 * (ADR-7), the page works without JavaScript, and "page" is not sent, so a
 * change of filters returns to page 1.
 */
export async function FiltersForm({
  options,
  params,
}: {
  options: FilterOptionsDto;
  params: ListingParams;
}) {
  const t = await getTranslations('filters');
  const tl = await getTranslations('listing');
  const sizeOptions = options.sizes.map((size) => ({ value: size.label, label: size.label }));
  return (
    <form method="get" className="flex flex-col gap-3" aria-label={t('title')}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{tl('sort')}</span>
        <select
          name="sort"
          defaultValue={params.sort}
          className="rounded-sm border border-border bg-surface px-2 py-2"
        >
          {SORT_OPTIONS.map(([value, key]) => (
            <option key={value} value={value}>
              {tl(key)}
            </option>
          ))}
        </select>
      </label>
      <Group
        legend={t('band')}
        name={FIELD.band}
        options={options.bands.map((band) => ({ value: String(band), label: String(band) }))}
        selected={params.bands.map(String)}
      />
      <Group
        legend={t('cup')}
        name={FIELD.cup}
        options={options.cups.map((cup) => ({ value: cup, label: cup }))}
        selected={params.cups}
      />
      <Group legend={t('size')} name={FIELD.size} options={sizeOptions} selected={params.sizes} />
      <Group
        legend={t('color')}
        name={FIELD.color}
        options={options.colors.map((color) => ({ value: color.slug, label: color.name }))}
        selected={params.colors}
      />
      <Group
        legend={t('brand')}
        name={FIELD.brand}
        options={options.brands.map((brand) => ({ value: brand, label: brand }))}
        selected={params.brands}
      />
      <fieldset className="flex flex-col gap-1 border-t border-border pt-3">
        <legend className="mb-1 text-sm font-medium">{t('price')}</legend>
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            {t('priceFrom')}
            <input
              type="number"
              name="price_min"
              min={0}
              inputMode="numeric"
              defaultValue={params.priceMin === null ? '' : Math.floor(params.priceMin / 100)}
              className="w-full rounded-sm border border-border bg-surface px-2 py-2"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            {t('priceTo')}
            <input
              type="number"
              name="price_max"
              min={0}
              inputMode="numeric"
              defaultValue={params.priceMax === null ? '' : Math.floor(params.priceMax / 100)}
              className="w-full rounded-sm border border-border bg-surface px-2 py-2"
            />
          </label>
        </div>
      </fieldset>
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="in_stock"
            value="1"
            defaultChecked={params.inStock}
            className="size-4"
          />
          {t('inStock')}
        </label>
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="sale"
            value="1"
            defaultChecked={params.onSale}
            className="size-4"
          />
          {t('onSale')}
        </label>
      </div>
      <button
        type="submit"
        className="min-h-10 rounded-full bg-accent px-5 py-2 text-sm text-accent-contrast"
      >
        {t('apply')}
      </button>
    </form>
  );
}
