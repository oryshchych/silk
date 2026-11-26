import { describe, expect, it } from 'vitest';

import { categoryTextToHtml } from './category-text.ts';

describe('categoryTextToHtml', () => {
  it('plain text: blank lines make paragraphs, single line breaks are spaces', () => {
    expect(categoryTextToHtml('First line\ncontinues.\n\nSecond paragraph.')).toBe(
      '<p>First line continues.</p><p>Second paragraph.</p>',
    );
  });
  it('plain text is escaped: an ampersand, a quote and a greater-than are text', () => {
    expect(categoryTextToHtml('Tom & "Jerry" > cat')).toBe(
      '<p>Tom &amp; &quot;Jerry&quot; &gt; cat</p>',
    );
  });
  it('empty or blank text stays empty', () => {
    expect(categoryTextToHtml('')).toBe('');
    expect(categoryTextToHtml('  \n\n  ')).toBe('');
  });
  it('html goes through the allowlist sanitiser: scripts, handlers and javascript: links are gone', () => {
    const out = categoryTextToHtml(
      '<h2>Title</h2><p onclick="x()">Text <a href="javascript:alert(1)">bad</a> <a href="https://ok.example/x">ok</a></p><script>alert(1)</script><img src=x onerror=alert(1)>',
    );
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('https://ok.example/x');
    for (const bad of ['<script', 'onclick', 'javascript:', '<img', 'onerror'])
      expect(out).not.toContain(bad);
  });
  it('a text over the sanitiser limit raises RangeError (the action turns it into a clean error)', () => {
    expect(() => categoryTextToHtml(`<p>${'x'.repeat(200_000)}</p>`)).toThrow(RangeError);
  });
});
