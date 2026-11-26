import { decodeBasicEntities } from './rich-text';

export interface FaqEntry {
  question: string;
  /** Sanitised html of the answer, as shown on the page. */
  answerHtml: string;
  /** The plain text of the same answer (what the structured data carries). */
  answerText: string;
}

const stripTags = (html: string): string =>
  decodeBasicEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Question and answer pairs from a FAQ document: an `<h2>` is a question and everything up to the next `<h2>`
 * is its answer. Works on SANITISED html only (the tags are the allowlist's, so the split is exact). A question
 * with no answer text is not an entry: the structured data must describe only what the page shows.
 */
export function parseFaqEntries(sanitizedHtml: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  const pattern = /<h2>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2>|$)/g;
  for (const match of sanitizedHtml.matchAll(pattern)) {
    const question = stripTags(match[1] ?? '');
    const answerHtml = (match[2] ?? '').trim();
    const answerText = stripTags(answerHtml);
    if (question !== '' && answerText !== '') entries.push({ question, answerHtml, answerText });
  }
  return entries;
}
