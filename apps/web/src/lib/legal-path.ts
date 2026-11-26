import { legalKindFromSlug, type LegalKind } from '@store/shared/legal';

export interface LegalPath {
  locale: 'uk' | 'en';
  /** The kind, or null when the word is not one of the fixed legal slugs. */
  kind: LegalKind | null;
}

/** `/legal/{word}` and `/en/legal/{word}`; the word is whatever the client sent. */
export function parseLegalPath(pathname: string): LegalPath | null {
  const match = /^\/(en\/)?legal\/([^/]+)$/.exec(pathname);
  const word = match?.[2];
  if (match === null || word === undefined) return null;
  return { locale: match[1] === undefined ? 'uk' : 'en', kind: legalKindFromSlug(word) };
}
