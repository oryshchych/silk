/**
 * Admin-authored rich text for the legal pages, safe by construction and checked twice.
 *
 *  1. `markdownToHtml` turns a SMALL Markdown subset into html. Every character of the source is
 *     escaped BEFORE any markup is added, so no source can produce a tag of its own: the only tags in
 *     the output are the ones this file writes.
 *  2. `sanitizeHtml` is an allowlist pass over html. It runs on WRITE (the result is what is stored)
 *     and again on RENDER (what the database holds is never trusted, whoever wrote it). It keeps a few
 *     tags with no attributes except a vetted `href`, and it escapes everything else: scripts, event
 *     handlers, `javascript:` and `data:` URLs, iframes, forms, styles and unknown tags never survive.
 *
 * No dependency: the allowlist is tiny, the input is a legal text, and a hand-written tokenizer is
 * easier to audit than a package whose full surface we would not use. Unit tests carry an XSS corpus.
 */

export const MAX_RICH_TEXT_CHARS = 100_000;

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'b',
  'i',
  'br',
  'hr',
  'a',
  'blockquote',
]);
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr']);
/** Elements whose CONTENT is also dropped (text inside them is code or hidden markup). */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'svg',
  'math',
  'textarea',
  'title',
  'form',
  'select',
  'option',
]);
const MAX_OPEN_TAGS = 30;

const escapeText = (text: string): string =>
  text
    .replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The plain text of an escaped string (used to compare and to build a search text). */
export function decodeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * A link target the shop accepts: https, http, mailto, tel, or a path on the site. Everything else
 * (javascript:, data:, vbscript:, a protocol-relative `//host`, a backslash trick, control characters,
 * an entity that could hide a scheme) returns null.
 */
export function safeHref(raw: string): string | null {
  // Only `&amp;` may appear as an entity: a browser would decode any other one before it reads the scheme.
  if (/&(?!amp;)/.test(raw)) return null;
  const value = raw.replace(/&amp;/g, '&');
  if (value.length === 0 || value.length > 2000) return null;

  if (/[\u0000- \u007f-\u009f\\<>"'`]/.test(value)) return null;
  if (/^(?:https?:\/\/[^/?#]+|mailto:[^/?#]+|tel:[+0-9()\-.]+)/i.test(value)) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
    } catch {
      return null;
    }
    return value;
  }
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return null;
}

const ATTR = String.raw`[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const TAG = new RegExp(String.raw`<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+${ATTR})*)\s*(\/?)>`, 'y');
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

function openTag(name: string, attrs: string): string {
  if (name !== 'a') return `<${name}>`;
  const match = HREF.exec(attrs);
  const href = safeHref(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
  // An anchor without a safe target is not a link: its text stays, the tag goes.
  return href === null ? '' : `<a href="${escapeText(href)}" rel="noopener noreferrer">`;
}

export function sanitizeHtml(html: string): string {
  if (html.length > MAX_RICH_TEXT_CHARS * 2) throw new RangeError('rich text is too long');
  const out: string[] = [];
  const stack: string[] = [];
  let skipUntil: string | null = null;
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (skipUntil !== null) {
      // Inside a dropped element: look for its closing tag only.
      const close = new RegExp(String.raw`</${skipUntil}\s*>`, 'i').exec(html.slice(index));
      if (close === null) break;
      index += close.index + close[0].length;
      skipUntil = null;
      continue;
    }
    if (lt === -1) {
      out.push(escapeText(html.slice(index)));
      break;
    }
    out.push(escapeText(html.slice(index, lt)));
    TAG.lastIndex = lt;
    const match = TAG.exec(html);
    if (match === null) {
      // Not a well-formed tag (`<`, `<scr<script>`, an unterminated tag): the `<` is text.
      out.push('&lt;');
      index = lt + 1;
      continue;
    }
    index = lt + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && match[4] !== '/') skipUntil = name;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) out.push(`</${stack.pop() ?? ''}>`);
      continue;
    }
    const tag = openTag(name, match[3] ?? '');
    if (tag === '') {
      // An anchor with no safe href: remember it so its closing tag is dropped as unmatched.
      continue;
    }
    out.push(tag);
    if (!VOID_TAGS.has(name)) {
      stack.push(name);
      if (stack.length > MAX_OPEN_TAGS) throw new RangeError('rich text is nested too deeply');
    }
  }
  while (stack.length > 0) out.push(`</${stack.pop() ?? ''}>`);
  return out.join('');
}

/** Inline Markdown on an ALREADY ESCAPED string: links, bold, italic. */
function inline(escaped: string): string {
  const pieces: string[] = [];
  const link = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g;
  let last = 0;
  for (let match = link.exec(escaped); match !== null; match = link.exec(escaped)) {
    pieces.push(emphasis(escaped.slice(last, match.index)));
    const href = safeHref(match[2] ?? '');
    const label = match[1] ?? '';
    pieces.push(
      href === null
        ? emphasis(label)
        : `<a href="${escapeText(href)}" rel="noopener noreferrer">${emphasis(label)}</a>`,
    );
    last = match.index + match[0].length;
  }
  pieces.push(emphasis(escaped.slice(last)));
  return pieces.join('');
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
}

/**
 * The Markdown subset the legal editor offers: `##`/`###`/`####` headings (the page's own title is the
 * h1), paragraphs, `-` and `1.` lists, `>` quotes, `---` rules, `**bold**`, `*italic*`, `[text](url)`.
 * Anything else is plain text. The result is run through `sanitizeHtml` as well, so the guarantee does not
 * depend on this function alone.
 */
export function markdownToHtml(source: string): string {
  if (source.length > MAX_RICH_TEXT_CHARS) throw new RangeError('rich text is too long');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  const state: { list: { tag: 'ul' | 'ol'; items: string[] } | null } = { list: null };

  const flushParagraph = (): void => {
    if (paragraph.length > 0) html.push(`<p>${inline(escapeText(paragraph.join(' ')))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    const list = state.list;
    if (list !== null) {
      html.push(
        `<${list.tag}>${list.items.map((item) => `<li>${inline(escapeText(item))}</li>`).join('')}</${list.tag}>`,
      );
    }
    state.list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      html.push('<hr>');
    } else if (heading !== null) {
      flushParagraph();
      flushList();
      const level = (heading[1] ?? '##').length;
      html.push(`<h${String(level)}>${inline(escapeText(heading[2] ?? ''))}</h${String(level)}>`);
    } else if (bullet !== null || numbered !== null) {
      flushParagraph();
      const tag = bullet !== null ? 'ul' : 'ol';
      if (state.list?.tag !== tag) {
        flushList();
        state.list = { tag, items: [] };
      }
      state.list.items.push((bullet ?? numbered)?.[1] ?? '');
    } else if (quote !== null) {
      flushParagraph();
      flushList();
      html.push(`<blockquote><p>${inline(escapeText(quote[1] ?? ''))}</p></blockquote>`);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return sanitizeHtml(html.join('\n'));
}
