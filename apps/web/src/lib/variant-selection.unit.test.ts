import { describe, expect, it } from 'vitest';

import { money } from '@store/shared/money';
import type { ProductImageDto, VariantDto } from '@store/shared/dto/catalog';

import {
  imagesForColor,
  initialSelection,
  selectColor,
  selectVariant,
  variantsOfColor,
} from './variant-selection';

const variant = (id: string, size: string, color: string, available: boolean): VariantDto => ({
  id,
  sizeLabel: size,
  sizeSystem: 'bra',
  band: 75,
  cup: 'B',
  colorSlug: color,
  price: money(100_00),
  available,
  lastUnits: false,
});

const variants = [
  variant('b75', '75B', 'black', true),
  variant('b80', '80B', 'black', false),
  variant('w75', '75B', 'white', false),
  variant('w80', '80B', 'white', true),
];

describe('selection', () => {
  it('starts on the first colour that has something to buy, with no size chosen', () => {
    expect(initialSelection(variants)).toEqual({ colorSlug: 'black', variantId: null });
    expect(
      initialSelection([variant('x', '75B', 'white', false), variant('y', '75B', 'black', true)]),
    ).toEqual({
      colorSlug: 'black',
      variantId: null,
    });
    expect(initialSelection([])).toEqual({ colorSlug: '', variantId: null });
  });

  it('selects an available size', () => {
    const state = selectVariant(initialSelection(variants), variants, 'b75');
    expect(state.variantId).toBe('b75');
  });

  it('never selects an unavailable size, an unknown id or a size of another colour', () => {
    const start = initialSelection(variants);
    expect(selectVariant(start, variants, 'b80')).toBe(start);
    expect(selectVariant(start, variants, 'nope')).toBe(start);
    expect(selectVariant(start, variants, 'w80')).toBe(start);
  });

  it('keeps the size on a colour change only if it is available there', () => {
    const chosen = selectVariant(initialSelection(variants), variants, 'b75');
    expect(selectColor(chosen, variants, 'white')).toEqual({ colorSlug: 'white', variantId: null });
    const other = selectVariant({ colorSlug: 'white', variantId: null }, variants, 'w80');
    expect(selectColor(other, variants, 'black')).toEqual({ colorSlug: 'black', variantId: null });
    const same = [...variants, variant('w75x', '80B', 'black', true)];
    expect(selectColor(other, same, 'black')).toEqual({ colorSlug: 'black', variantId: 'w75x' });
  });

  it('ignores an unknown colour', () => {
    const start = initialSelection(variants);
    expect(selectColor(start, variants, 'green')).toBe(start);
  });

  it('lists the variants of one colour', () => {
    expect(variantsOfColor(variants, 'white').map((v) => v.id)).toEqual(['w75', 'w80']);
  });
});

describe('imagesForColor', () => {
  const image = (url: string, colorSlug: string | null): ProductImageDto => ({
    url,
    alt: url,
    width: 800,
    height: 1000,
    colorSlug,
  });
  const images = [image('shared', null), image('black-1', 'black'), image('white-1', 'white')];

  it('shows the colour photos and the colour-less ones', () => {
    expect(imagesForColor(images, 'black').map((i) => i.url)).toEqual(['shared', 'black-1']);
  });

  it('falls back to every photo when nothing matches', () => {
    const onlyBlack = [image('black-1', 'black')];
    expect(imagesForColor(onlyBlack, 'white')).toEqual(onlyBlack);
    expect(imagesForColor([], 'white')).toEqual([]);
  });
});
