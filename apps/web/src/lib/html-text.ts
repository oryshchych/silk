import { visibleText } from '@store/shared/content-text';

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
};

/** One pass: `&amp;lt;` becomes `&lt;`, never `<`. Unknown or out-of-range references stay as written. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi,
    (entity, dec, hex, name) => {
      if (typeof name === 'string') return NAMED[name.toLowerCase()] ?? entity;
      const code = typeof dec === 'string' ? Number(dec) : Number.parseInt(String(hex), 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    },
  );
}

/**
 * Plain-text paragraphs of an HTML fragment. Descriptions are rich text, but
 * there is no sanitiser yet (it comes with the admin editor), so the page
 * shows text only and never injects the markup. Tags are dropped, block ends
 * become paragraph breaks, common entities are decoded.
 */
export function htmlToParagraphs(html: string | null): string[] {
  if (html === null) return [];
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol)>|<br\s*\/?>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    // A tag starts with a letter or a slash and a letter: `5 < 6 > 3` is text, not a tag.
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
  const decoded = decodeEntities(text);
  return (
    decoded
      .split('\n')
      // The same "visible text" rule as the readiness report: a line of zero-width characters is no line.
      .map((line) => visibleText(line))
      .filter((line) => line !== '')
  );
}

/** Single-line text cut at a word boundary, for meta descriptions and JSON-LD. */
export function htmlToSnippet(html: string | null, maxLength: number): string | null {
  const text = htmlToParagraphs(html).join(' ');
  if (text === '') return null;
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxLength / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
