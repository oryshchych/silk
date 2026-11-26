import { describe, expect, it } from 'vitest';

import { formatSizesCookie, parseSizesCookie, sizeHint, type SizedVariant } from './my-sizes';

const bra = (label: string, available: boolean, colorSlug = 'black'): SizedVariant => ({
  sizeLabel: label,
  band: 75,
  colorSlug,
  available,
});

describe('saved sizes cookie', () => {
  // What the browser holds: the framework percent-encodes the value it is given, once.
  const onTheWire = (value: string): string => encodeURIComponent(value);

  it('round-trips through the framework encoding and survives odd labels', () => {
    const wire = onTheWire(formatSizesCookie({ bra: '75B', apparel: 'One size' }));
    expect(wire).toBe('bra%3A75B%7Capparel%3AOne%20size');
    expect(parseSizesCookie(wire)).toEqual({ bra: '75B', apparel: 'One size' });
    expect(parseSizesCookie(onTheWire(formatSizesCookie({ bra: null, apparel: 'M' })))).toEqual({
      bra: null,
      apparel: 'M',
    });
  });

  it('a double-encoded value (the old bug) reads as none, never as a wrong size', () => {
    const twice = encodeURIComponent(onTheWire(formatSizesCookie({ bra: '75B', apparel: 'M' })));
    expect(parseSizesCookie(twice)).toEqual({ bra: null, apparel: null });
  });

  it('reads garbage, markup, over-long and undecodable values as "none"', () => {
    for (const raw of [undefined, null, '', '%E0%A4%A', 'x'.repeat(200), 'bra%3A%3Cscript%3E']) {
      expect(parseSizesCookie(raw), String(raw)).toEqual({ bra: null, apparel: null });
    }
  });
});

describe('sizeHint', () => {
  it('shows nothing without a saved size', () => {
    expect(sizeHint([bra('75B', true)], 'black', { bra: null, apparel: 'M' })).toEqual({
      kind: 'none',
    });
  });
  it('marks an available size', () => {
    expect(sizeHint([bra('75B', true)], 'black', { bra: '75B', apparel: null }).kind).toBe(
      'available',
    );
  });
  it('warns when the size exists but is sold out, or does not exist, in that colour', () => {
    expect(sizeHint([bra('75B', false)], 'black', { bra: '75B', apparel: null })).toEqual({
      kind: 'unavailable',
      label: '75B',
    });
    expect(sizeHint([bra('80B', true)], 'black', { bra: '75B', apparel: null }).kind).toBe(
      'unavailable',
    );
    expect(sizeHint([bra('75B', true, 'red')], 'black', { bra: '75B', apparel: null }).kind).toBe(
      'none',
    );
  });
  it('uses the apparel size for a product without bands', () => {
    const variants: SizedVariant[] = [
      { sizeLabel: 'M', band: null, colorSlug: 'c', available: true },
    ];
    expect(sizeHint(variants, 'c', { bra: '75B', apparel: 'M' }).kind).toBe('available');
  });
});
