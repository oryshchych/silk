import { describe, expect, it } from 'vitest';

import { sniffImage, sniffPdf } from './sniff.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('sniffImage: what a file really is', () => {
  it('recognises JPEG, PNG and WebP by their first bytes', () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png');
    expect(sniffImage(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('webp');
  });

  it('refuses SVG (it can carry script), GIF, HTML renamed to an image, PDF, and empty or truncated input', () => {
    for (const bad of [
      text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      text('<?xml version="1.0"?><svg/>'),
      text('GIF89a'),
      text('<!doctype html><html></html>'),
      text('%PDF-1.7'),
      bytes(),
      bytes(0xff, 0xd8),
      bytes(0x89, 0x50, 0x4e),
      text('RIFF\u0000\u0000\u0000\u0000WAVEfmt '),
    ]) {
      expect(sniffImage(bad)).toBeNull();
    }
  });
});

describe('sniffPdf: a PDF is read from its bytes', () => {
  const text = (value: string) => new TextEncoder().encode(value);

  it('accepts %PDF- with a version at the very start', () => {
    expect(sniffPdf(text('%PDF-1.7\n%\u00e2\u00e3'))).toBe(true);
    expect(sniffPdf(text('%PDF-2.0\n'))).toBe(true);
  });

  it('refuses everything that only claims to be one', () => {
    expect(sniffPdf(text('<html><script>alert(1)</script>'))).toBe(false);
    expect(sniffPdf(text('  %PDF-1.7'))).toBe(false);
    expect(sniffPdf(text('<!-- %PDF-1.7 -->'))).toBe(false);
    expect(sniffPdf(text('%PDF-'))).toBe(false);
    expect(sniffPdf(new Uint8Array(0))).toBe(false);
    expect(sniffPdf(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe(false);
  });
});
