/**
 * "Your size" on the product page. The saved sizes travel in a plain cookie (`silk_sizes`, set by
 * the account when the customer saves them) and are read by the browser AFTER hydration, so the
 * cached product HTML is the same for everyone and carries nothing personal. A size label is not a
 * secret and the cookie only ever changes the visitor's own hint.
 */
export const SIZES_COOKIE = 'silk_sizes';

export interface MySizes {
  bra: string | null;
  apparel: string | null;
}

const LABEL = /^[\p{L}\p{N} .+/-]{1,20}$/u;

export function formatSizesCookie(sizes: MySizes): string {
  return encodeURIComponent(`bra:${sizes.bra ?? ''}|apparel:${sizes.apparel ?? ''}`);
}

/** The saved sizes of a cookie value; anything malformed reads as "none". */
export function parseSizesCookie(raw: string | null | undefined): MySizes {
  const none: MySizes = { bra: null, apparel: null };
  if (raw === null || raw === undefined || raw.length > 100) return none;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return none;
  }
  const out: MySizes = { bra: null, apparel: null };
  for (const part of decoded.split('|')) {
    const [key, value] = part.split(':');
    if (value === undefined || !LABEL.test(value)) continue;
    if (key === 'bra') out.bra = value;
    if (key === 'apparel') out.apparel = value;
  }
  return out;
}

export interface SizedVariant {
  sizeLabel: string;
  band: number | null;
  colorSlug: string;
  available: boolean;
}

export type SizeHint =
  | { kind: 'none' }
  | { kind: 'available'; label: string; variantLabels: string[] }
  | { kind: 'unavailable'; label: string };

/**
 * The hint for the chosen colour: the product uses the bra size when its variants have a band,
 * the apparel size otherwise. "Missing" means no variant of that size is available in this colour.
 */
export function sizeHint(
  variants: readonly SizedVariant[],
  colorSlug: string,
  saved: MySizes,
): SizeHint {
  const ofColor = variants.filter((variant) => variant.colorSlug === colorSlug);
  if (ofColor.length === 0) return { kind: 'none' };
  const isBra = ofColor.some((variant) => variant.band !== null);
  const label = isBra ? saved.bra : saved.apparel;
  if (label === null) return { kind: 'none' };
  const match = ofColor.find((variant) => variant.sizeLabel === label && variant.available);
  return match === undefined
    ? { kind: 'unavailable', label }
    : { kind: 'available', label, variantLabels: [match.sizeLabel] };
}
