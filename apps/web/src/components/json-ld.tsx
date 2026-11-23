import { serializeJsonLd } from '@store/shared/schema-org';

/**
 * The only place JSON-LD is written into the page. `serializeJsonLd` escapes
 * `<`, `>`, `&` and the line separators, so catalog text cannot close the
 * script element; the data comes from the typed builders in
 * `@store/shared/schema-org`.
 */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
