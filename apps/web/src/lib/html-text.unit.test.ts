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

describe('htmlToParagraphs: entities and stray angle brackets', () => {
  it('decodes named and numeric references in one pass', () => {
    expect(htmlToParagraphs('<p>&laquo;Soft&raquo; lace&hellip; &#8212; &#x41;&#65;</p>')).toEqual([
      '«Soft» lace… — AA',
    ]);
  });

  it('never decodes twice: an encoded entity stays an entity', () => {
    expect(htmlToParagraphs('<p>&amp;lt;b&amp;gt; &amp;amp;</p>')).toEqual(['&lt;b&gt; &amp;']);
  });

  it('leaves unknown names and impossible code points as written', () => {
    expect(htmlToParagraphs('<p>&bogus; &#0; &#xD800; &#99999999; &#x110000;</p>')).toEqual([
      '&bogus; &#0; &#xD800; &#99999999; &#x110000;',
    ]);
  });

  it('keeps text between a less-than and a greater-than that is not a tag', () => {
    expect(htmlToParagraphs('<p>5 < 6 > 3 and a<b>b</b></p>')).toEqual(['5 < 6 > 3 and ab']);
    expect(htmlToParagraphs('<p>x</p><!-- hidden <b>note</b> --><p>y</p>')).toEqual(['x', 'y']);
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

describe('htmlToParagraphs and invisible text', () => {
  it('a text of only zero-width characters or blanks has no paragraph', () => {
    expect(htmlToParagraphs('\u200b\u200b\u200c')).toEqual([]);
    expect(htmlToParagraphs('<p>\u00a0</p><p>\u200b</p>')).toEqual([]);
    expect(htmlToParagraphs('<p>Real</p><p>\u200b</p>')).toEqual(['Real']);
  });
});
