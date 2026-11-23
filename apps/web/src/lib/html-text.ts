const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

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
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity);
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
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
