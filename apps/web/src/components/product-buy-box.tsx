'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { calculateBraSize } from '@store/core/bra-size';
import type { AnalyticsItem } from '@store/shared/analytics';
import type { ColorDto, ProductImageDto } from '@store/shared/dto/catalog';

import { AddToCartButton } from '@/components/add-to-cart-button';
import { ProductAccountActions } from '@/components/product-account-actions';
import { MySizeNotice } from '@/components/my-size-notice';
import { ResponsiveImage } from '@/components/responsive-image';
import { GALLERY_SIZES } from '@/lib/image-sizes';
import {
  imagesForColor,
  initialSelection,
  selectColor,
  selectVariant,
  variantsOfColor,
  type SelectableVariant,
} from '@/lib/variant-selection';

const FIELD = { color: 'color', size: 'size' } as const;
const THUMB_SIZES = '80px';

interface Props {
  name: string;
  images: ProductImageDto[];
  colors: ColorDto[];
  variants: SelectableVariant[];
  /**
   * Prices are formatted on the server and passed as text: `Intl` currency
   * output differs between Node and browsers (spaces, symbol), which made the
   * client render disagree with the server HTML (hydration error).
   */
  prices: { base: string; compareAt: string | null; byVariant: Record<string, string> };
  /** Locale-prefixed cart path, for the "view cart" link. */
  cartHref: string;
  /** Account actions on the page (wishlist, back-in-stock alerts). */
  productId: string;
  loginHref: string;
  /** What "add to cart" reports to analytics, per variant id (built on the server). */
  trackItems: Record<string, AnalyticsItem>;
}

function Gallery({ images, name }: { images: ProductImageDto[]; name: string }) {
  const t = useTranslations('product');
  const [chosen, setChosen] = useState(0);
  const index = Math.min(chosen, Math.max(images.length - 1, 0));
  const main = images[index];
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t('gallery')}>
      <div className="relative aspect-[4/5] overflow-hidden rounded-sm bg-surface-raised">
        {main === undefined ? (
          <span className="flex h-full items-center justify-center text-sm text-text-muted">
            {name}
          </span>
        ) : (
          <ResponsiveImage
            url={main.url}
            alt={main.alt}
            width={main.width}
            height={main.height}
            sizes={GALLERY_SIZES}
            priority
            className="h-full w-full object-cover"
          />
        )}
      </div>
      {images.length > 1 ? (
        <ul className="flex flex-wrap gap-2">
          {images.map((image, position) => (
            <li key={image.url}>
              <button
                type="button"
                onClick={() => {
                  setChosen(position);
                }}
                aria-label={t('photo', { index: position + 1, count: images.length })}
                aria-current={position === index}
                className="size-16 overflow-hidden rounded-sm border border-border aria-[current=true]:border-accent"
              >
                <ResponsiveImage
                  url={image.url}
                  alt=""
                  width={image.width}
                  height={image.height}
                  sizes={THUMB_SIZES}
                  className="h-full w-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SizeCalculator({
  variants,
  colorSlug,
  onPick,
}: {
  variants: SelectableVariant[];
  colorSlug: string;
  onPick: (variantId: string) => void;
}) {
  const t = useTranslations('product');
  const underbustId = useId();
  const bustId = useId();
  const [message, setMessage] = useState<{
    text: string;
    pick?: { id: string; label: string };
  } | null>(null);

  function submit(form: FormData): void {
    const underbust = Number(form.get('underbust'));
    const bust = Number(form.get('bust'));
    const result = calculateBraSize(underbust, bust);
    if (!result.ok) {
      const key =
        result.reason === 'underbust_out_of_range'
          ? 'calcUnderbustRange'
          : result.reason === 'cup_out_of_range'
            ? 'calcCupRange'
            : 'calcInvalid';
      setMessage({ text: t(key) });
      return;
    }
    const match = variants.find(
      (variant) =>
        variant.colorSlug === colorSlug &&
        variant.band === result.band &&
        variant.cup === result.cup &&
        variant.available,
    );
    setMessage(
      match === undefined
        ? {
            text: `${t('calcResult', { size: result.label })} ${t('calcUnavailable', { size: result.label })}`,
          }
        : {
            text: t('calcResult', { size: result.label }),
            pick: { id: match.id, label: result.label },
          },
    );
  }

  return (
    <details className="rounded-sm border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">{t('calcTitle')}</summary>
      <form action={submit} className="mt-3 flex flex-col gap-3">
        <label htmlFor={underbustId} className="flex flex-col gap-1 text-sm">
          {t('calcUnderbust')}
          <input
            id={underbustId}
            name="underbust"
            type="number"
            inputMode="decimal"
            min={1}
            required
            className="rounded-sm border border-border bg-surface px-2 py-2"
          />
        </label>
        <label htmlFor={bustId} className="flex flex-col gap-1 text-sm">
          {t('calcBust')}
          <input
            id={bustId}
            name="bust"
            type="number"
            inputMode="decimal"
            min={1}
            required
            className="rounded-sm border border-border bg-surface px-2 py-2"
          />
        </label>
        <button type="submit" className="min-h-10 rounded-full border border-border px-4 text-sm">
          {t('calcSubmit')}
        </button>
      </form>
      <div aria-live="polite" className="mt-3 text-sm">
        {message === null ? null : <p>{message.text}</p>}
        {message?.pick === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              if (message.pick !== undefined) onPick(message.pick.id);
            }}
            className="mt-2 min-h-10 rounded-full bg-accent px-4 text-accent-contrast"
          >
            {t('calcPick', { size: message.pick.label })}
          </button>
        )}
      </div>
    </details>
  );
}

export function ProductBuyBox({
  name,
  images,
  colors,
  variants,
  prices,
  cartHref,
  productId,
  loginHref,
  trackItems,
}: Props) {
  const t = useTranslations('product');
  const [selection, setSelection] = useState(() => initialSelection(variants));
  const sizes = variantsOfColor(variants, selection.colorSlug);
  const selected = variants.find((variant) => variant.id === selection.variantId);
  const shown = (selected === undefined ? undefined : prices.byVariant[selected.id]) ?? prices.base;
  const hasBras = variants.some((variant) => variant.sizeSystem === 'bra');

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <Gallery
        key={selection.colorSlug}
        images={imagesForColor(images, selection.colorSlug)}
        name={name}
      />
      <div className="flex flex-col gap-5">
        <p className="flex items-baseline gap-3 text-2xl">
          <span>{shown}</span>
          {prices.compareAt === null || selected !== undefined ? null : (
            <s className="text-base text-text-muted">{prices.compareAt}</s>
          )}
        </p>

        {colors.length > 1 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('color')}</legend>
            <div className="flex flex-wrap gap-2">
              {colors.map((color) => (
                <label
                  key={color.slug}
                  className="flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-sm has-[:checked]:border-accent has-[:focus-visible]:outline-2"
                >
                  <input
                    type="radio"
                    name={FIELD.color}
                    value={color.slug}
                    checked={selection.colorSlug === color.slug}
                    onChange={() => {
                      setSelection((state) => selectColor(state, variants, color.slug));
                    }}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="size-4 rounded-full border border-border"
                    style={{ backgroundColor: color.hex }}
                  />
                  {color.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('size')}</legend>
          <div className="flex flex-wrap gap-2">
            {sizes.map((variant) => (
              <label
                key={variant.id}
                className="flex min-h-10 min-w-12 cursor-pointer items-center justify-center rounded-sm border border-border px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-accent-contrast has-[:disabled]:cursor-not-allowed has-[:disabled]:text-text-muted has-[:disabled]:line-through has-[:focus-visible]:outline-2"
              >
                <input
                  type="radio"
                  name={FIELD.size}
                  value={variant.id}
                  checked={selection.variantId === variant.id}
                  disabled={!variant.available}
                  onChange={() => {
                    setSelection((state) => selectVariant(state, variants, variant.id));
                  }}
                  className="sr-only"
                />
                <span aria-hidden={!variant.available}>{variant.sizeLabel}</span>
                {variant.available ? null : (
                  <span className="sr-only">
                    {t('sizeUnavailable', { size: variant.sizeLabel })}
                  </span>
                )}
              </label>
            ))}
          </div>
        </fieldset>

        <p aria-live="polite" className="text-sm text-text-muted">
          {sizes.every((variant) => !variant.available)
            ? t('outOfStock')
            : selected === undefined
              ? t('chooseSize')
              : selected.lastUnits
                ? t('lastUnits')
                : t('inStock')}
        </p>

        <MySizeNotice variants={variants} colorSlug={selection.colorSlug} />

        <AddToCartButton
          variantId={selected?.available === true ? selected.id : null}
          cartHref={cartHref}
          trackItem={selected === undefined ? null : (trackItems[selected.id] ?? null)}
        />

        <ProductAccountActions
          productId={productId}
          variants={variants}
          colorSlug={selection.colorSlug}
          loginHref={loginHref}
        />

        {hasBras ? (
          <SizeCalculator
            variants={variants}
            colorSlug={selection.colorSlug}
            onPick={(variantId) => {
              setSelection((state) => selectVariant(state, variants, variantId));
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
