/**
 * Bra size calculator: (underbust, bust) in centimetres to a European band
 * and cup. A pure function, no I/O (docs/architecture/04-data-model.md).
 *
 * The correspondence table is the standard European one and is a PLACEHOLDER
 * until the shop confirms it against the brands' own size charts (owner
 * queue Q19). Changing it is a data change in `CUP_TABLE`, not a code change.
 */

export const BAND_STEP = 5;
export const MIN_BAND = 60;
export const MAX_BAND = 110;

/**
 * Cup by the difference (bust minus underbust, whole centimetres). Each row
 * covers `from` up to the next row's `from` (exclusive); the last row covers
 * `from` to `from + CUP_STEP - 1`.
 */
export const CUP_TABLE: readonly { readonly from: number; readonly cup: string }[] = [
  { from: 10, cup: 'AA' },
  { from: 12, cup: 'A' },
  { from: 14, cup: 'B' },
  { from: 16, cup: 'C' },
  { from: 18, cup: 'D' },
  { from: 20, cup: 'E' },
  { from: 22, cup: 'F' },
  { from: 24, cup: 'G' },
  { from: 26, cup: 'H' },
];
const CUP_STEP = 2;

export type BraSizeFailure = 'invalid_input' | 'underbust_out_of_range' | 'cup_out_of_range';

export type BraSizeResult =
  { ok: true; band: number; cup: string; label: string } | { ok: false; reason: BraSizeFailure };

/**
 * Measurements are rounded to whole centimetres first (`Math.round`, halves
 * up), then the band to the nearest multiple of 5. So 72 cm gives 70 and
 * 73 cm gives 75.
 */
export function calculateBraSize(underbustCm: number, bustCm: number): BraSizeResult {
  if (!Number.isFinite(underbustCm) || !Number.isFinite(bustCm) || underbustCm <= 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  const underbust = Math.round(underbustCm);
  const bust = Math.round(bustCm);
  const band = BAND_STEP * Math.round(underbust / BAND_STEP);
  if (band < MIN_BAND || band > MAX_BAND) {
    return { ok: false, reason: 'underbust_out_of_range' };
  }

  const difference = bust - underbust;
  const first = CUP_TABLE[0];
  const last = CUP_TABLE[CUP_TABLE.length - 1];
  if (first === undefined || last === undefined) return { ok: false, reason: 'cup_out_of_range' };
  if (difference < first.from || difference >= last.from + CUP_STEP) {
    return { ok: false, reason: 'cup_out_of_range' };
  }

  let cup = first.cup;
  for (const row of CUP_TABLE) {
    if (difference >= row.from) cup = row.cup;
  }
  return { ok: true, band, cup, label: `${String(band)}${cup}` };
}
