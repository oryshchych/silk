import { describe, expect, it } from 'vitest';

import { cleanText, visibleLength, visibleText } from './content-text';

describe('visibleText and visibleLength', () => {
  it('invisible characters and blank runs do not count', () => {
    expect(visibleText('  a  b​  ')).toBe('a b');
    expect(visibleLength('​‌‍')).toBe(0);
    expect(visibleLength(' ')).toBe(0);
    expect(visibleLength('😀 emoji')).toBe(7);
  });
});

describe('cleanText', () => {
  it('removes zero-width, bidi and control characters, keeps tab and line feed', () => {
    expect(cleanText('a​b‮c⁦d\u0007e\u0000f\tg\nh')).toBe('abcdef\tg\nh');
  });
  it('normalises line breaks to a line feed', () => {
    expect(cleanText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
  it('leaves ordinary Ukrainian and English text alone', () => {
    const text = 'Бюстгальтер «Аврора», 95% cotton — 5% elastane.';
    expect(cleanText(text)).toBe(text);
  });
});
