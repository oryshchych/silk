import { clampPage, normalizeSearchQuery } from '@store/core/catalog';

/** `q` and `page` from the raw query string: first value only; junk becomes the empty query and page 1. */
export function readSearchQuery(raw: Record<string, string | string[] | undefined>): {
  query: string;
  page: number;
} {
  const first = (value: string | string[] | undefined): string =>
    (Array.isArray(value) ? value[0] : value) ?? '';
  const page = first(raw['page']);
  return {
    query: normalizeSearchQuery(first(raw['q'])),
    page: /^\d{1,4}$/.test(page) ? clampPage(Number(page)) : 1,
  };
}
