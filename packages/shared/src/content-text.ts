/**
 * The text a visitor can read, as a length. The SAME rule as `norm()` in
 * `packages/core/src/content-readiness/read.ts` (SQL): zero-width characters removed, every run of
 * blanks (NBSP and the line separators included) folded to one space, trimmed. The import preview
 * measures with this function and the readiness report with the SQL; an integration test feeds both
 * the same samples, so a preview that says "ok" cannot be contradicted by the report.
 */
export function visibleText(value: string): string {
  return value
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\s\u00a0\u2028\u2029]+/g, ' ')
    .trim();
}

/** Length in code points (what Postgres `char_length` counts), of the visible text. */
export const visibleLength = (value: string): number => Array.from(visibleText(value)).length;
