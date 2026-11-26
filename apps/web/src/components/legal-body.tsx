import { sanitizeHtml } from '@store/shared/rich-text';

/**
 * The html of a legal page. The core read already sanitised it; it is sanitised ONCE MORE here, at the
 * point it enters the page, so nothing that reaches this component as a string is trusted (allowlist
 * of tags, no attribute but a vetted `href`, no script, no handler, no `javascript:` URL).
 *
 * The sanitiser refuses an input over its size limit and a nesting over its depth limit (`RangeError`), and the
 * read's OUTPUT is longer than its input (`<` becomes `&lt;`), so this second pass can refuse text the first one
 * accepted. That must never be a 500: the page then renders with no body (like the read does) and stays 200.
 */
function safeHtml(html: string): string {
  try {
    return sanitizeHtml(html);
  } catch (error) {
    if (error instanceof RangeError) return '';
    throw error;
  }
}

export function LegalBody({ html }: { html: string }) {
  return (
    <div
      className="legal-body flex flex-col gap-3 [&_a]:underline [&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-xl [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
      dangerouslySetInnerHTML={{ __html: safeHtml(html) }}
    />
  );
}
