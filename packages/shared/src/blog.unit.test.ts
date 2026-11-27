import { describe, expect, it } from 'vitest';

import {
  descriptionFromHtml,
  isBlogSlug,
  isBlogTag,
  POST_FORM_MAX_BYTES,
  postPayloadBytes,
} from './blog';

describe('descriptionFromHtml', () => {
  it('takes the first paragraph as plain text', () => {
    expect(
      descriptionFromHtml(
        '<h2>Title</h2><p>First <strong>para</strong> &amp; more.</p><p>Second.</p>',
      ),
    ).toBe('First para & more.');
  });

  it('cuts a long paragraph at a word near 155 characters with an ellipsis', () => {
    const text = Array.from({ length: 80 }, (_, i) => `word${String(i)}`).join(' ');
    const out = descriptionFromHtml(`<p>${text}</p>`) ?? '';
    expect(out.length).toBeLessThanOrEqual(155);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('is null for a body with no paragraph text, and never contains a tag', () => {
    expect(descriptionFromHtml('')).toBeNull();
    expect(descriptionFromHtml('<ul><li>x</li></ul>')).toBeNull();
    expect(descriptionFromHtml('<p> </p>')).toBeNull();
    expect(descriptionFromHtml('<p>a <em>b</em> <a href="/x">c</a></p>')).toBe('a b c');
  });
});

describe('blog words and size', () => {
  it('the reserved shape words', () => {
    expect(isBlogSlug('how-to')).toBe(true);
    expect(isBlogSlug('A')).toBe(false);
    expect(isBlogTag('x'.repeat(41))).toBe(false);
  });
  it('measures serialised UTF-8 bytes, so a Cyrillic character counts twice', () => {
    expect(postPayloadBytes({ a: 'я' })).toBe(postPayloadBytes({ a: 'a' }) + 1);
    expect(POST_FORM_MAX_BYTES).toBeLessThan(64 * 1024);
  });
});
