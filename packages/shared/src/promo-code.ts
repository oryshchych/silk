/**
 * Generated promo codes: 8 characters without the look-alikes (no 0/O, no 1/I/L), so a code read
 * from a screenshot or aloud is typed right. Pure: the caller supplies the randomness (`randomInt`
 * on the server, Web Crypto in the browser).
 */
export const PROMO_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GENERATED_PROMO_CODE_LENGTH = 8;

export function generatePromoCode(randomBelow: (limit: number) => number): string {
  let out = '';
  for (let i = 0; i < GENERATED_PROMO_CODE_LENGTH; i += 1) {
    out += PROMO_CODE_ALPHABET.charAt(randomBelow(PROMO_CODE_ALPHABET.length));
  }
  return out;
}
