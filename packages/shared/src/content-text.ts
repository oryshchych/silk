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

/**
 * Text as it may be STORED: line breaks are `\n`, zero-width characters, bidirectional controls
 * (U+202A to U+202E, U+2066 to U+2069: they can reorder what a reader sees) and control characters
 * other than the tab and the line feed are removed. Applied to every admin text input and to every
 * imported cell, so the report's "visible text" and the stored text cannot differ by invisible
 * characters.
 */
export function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}
