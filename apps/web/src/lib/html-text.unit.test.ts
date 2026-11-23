import { describe, expect, it } from 'vitest';

import { htmlToParagraphs, htmlToSnippet } from './html-text';

describe('htmlToParagraphs', () => {
  it('drops tags and splits on block ends', () => {
    expect(htmlToParagraphs('<p>One <b>bold</b></p><p>Two<br>three</p>')).toEqual([
      'One bold',
      'Two',
      'three',
    ]);
  });

  it('never keeps markup or script content', () => {
    const out = htmlToParagraphs('<p>Hi</p><script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(out).toEqual(['Hi']);
    expect(out.join('')).not.toMatch(/[<>]|alert/);
  });

  it('decodes common entities and handles null and empty input', () => {
    expect(htmlToParagraphs('<p>A &amp; B&nbsp;&quot;C&quot;</p>')).toEqual(['A & B "C"']);
    expect(htmlToParagraphs(null)).toEqual([]);
    expect(htmlToParagraphs('')).toEqual([]);
  });
});

describe('htmlToSnippet', () => {
  it('returns short text as is and null for nothing', () => {
    expect(htmlToSnippet('<p>Soft lace</p>', 160)).toBe('Soft lace');
    expect(htmlToSnippet('<p></p>', 160)).toBeNull();
    expect(htmlToSnippet(null, 160)).toBeNull();
  });

  it('cuts long text at a word boundary with an ellipsis within the limit', () => {
    const snippet = htmlToSnippet(`<p>${'word '.repeat(60)}</p>`, 50);
    expect(snippet?.length).toBeLessThanOrEqual(50);
    expect(snippet?.endsWith('…')).toBe(true);
    expect(snippet).not.toContain('wor…');
  });
});
