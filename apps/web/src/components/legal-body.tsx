import { sanitizeHtml } from '@store/shared/rich-text';

/**
 * The html of a legal page. The core read already sanitised it; it is sanitised ONCE MORE here, at the
 * point it enters the page, so nothing that reaches this component as a string is trusted (allowlist
 * of tags, no attribute but a vetted `href`, no script, no handler, no `javascript:` URL).
 */
export function LegalBody({ html }: { html: string }) {
  return (
    <div
      className="legal-body flex flex-col gap-3 [&_a]:underline [&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-xl [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  );
}
