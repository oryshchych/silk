import { describe, expect, it } from 'vitest';

import { parseFaqEntries } from './faq';
import { markdownToHtml } from './rich-text';

describe('parseFaqEntries', () => {
  it('pairs each h2 with the answer that follows it', () => {
    const html = markdownToHtml(
      '## One?\n\nAnswer **one**.\n\n- a\n- b\n\n## Two?\n\nAnswer two & more.',
    );
    const entries = parseFaqEntries(html);
    expect(entries.map((e) => e.question)).toEqual(['One?', 'Two?']);
    expect(entries[0]?.answerText).toBe('Answer one . a b');
    expect(entries[1]?.answerText).toBe('Answer two & more.');
    expect(entries[0]?.answerHtml).toContain('<ul>');
  });

  it('skips a question without an answer and text before the first question', () => {
    expect(parseFaqEntries(markdownToHtml('Intro\n\n## Lonely?\n\n## Real?\n\nYes.'))).toEqual([
      { question: 'Real?', answerHtml: '<p>Yes.</p>', answerText: 'Yes.' },
    ]);
  });

  it('returns nothing for a page with no headings', () => {
    expect(parseFaqEntries('<p>text</p>')).toEqual([]);
  });
});
