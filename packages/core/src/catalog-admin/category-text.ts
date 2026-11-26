/**
 * The category texts as the editor receives them. A person writing a category text types plain
 * paragraphs, not markup, so:
 *  - a text WITHOUT any `<` is plain text: blank lines separate paragraphs, each becomes `<p>`, and
 *    every character is escaped (a `&` or a quote is text, never an entity or an attribute);
 *  - a text WITH a `<` is HTML and goes through the same allowlist sanitiser the storefront applies
 *    again when it renders (`sanitizeHtml`: p, headings, lists, em, strong, https links).
 * The result is what is stored; an empty text stays empty (the column becomes NULL).
 */
import { sanitizeHtml } from '@store/shared/rich-text';

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function categoryTextToHtml(value: string): string {
  const text = value.trim();
  if (text === '') return '';
  if (text.includes('<')) return sanitizeHtml(text);
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s*\r?\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escapeText(paragraph)}</p>`)
    .join('');
}
