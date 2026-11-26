import { describe, expect, it } from 'vitest';

import { renditionSources } from './renditions';

const ID = '0190a1b2-0000-7000-8000-000000000001';
const IMG = '0190a1b2-0000-7000-8000-0000000000aa';
const url = `https://media.shop.example/products/${ID}/${IMG}/full.webp`;

describe('renditionSources', () => {
  it('derives AVIF and WebP srcsets at the three widths from the full WebP url', () => {
    const base = `https://media.shop.example/products/${ID}/${IMG}`;
    expect(renditionSources(url, 3000)).toEqual({
      avif: `${base}/thumb.avif 320w, ${base}/card.avif 800w, ${base}/full.avif 1600w`,
      webp: `${base}/thumb.webp 320w, ${base}/card.webp 800w, ${base}/full.webp 1600w`,
    });
  });

  it('never claims a width the file does not have (a small source), and drops duplicate widths', () => {
    const base = `https://media.shop.example/products/${ID}/${IMG}`;
    expect(renditionSources(url, 700)?.webp).toBe(
      `${base}/thumb.webp 320w, ${base}/card.webp 700w`,
    );
    expect(renditionSources(url, 200)?.avif).toBe(`${base}/thumb.avif 200w`);
  });

  it('has no renditions for anything that is not an upload (the placeholder, a foreign host shape, http, a query)', () => {
    for (const other of [
      '/placeholder.svg',
      `http://media.shop.example/products/${ID}/${IMG}/full.webp`,
      `https://media.shop.example/products/${ID}/${IMG}/full.webp?x=1`,
      `https://media.shop.example/products/${ID}/${IMG}/card.webp`,
      `https://media.shop.example/products/not-an-id/${IMG}/full.webp`,
      `https://media.shop.example/products/${ID}/${IMG}/full.webp" onerror="x`,
      'javascript:alert(1)',
    ]) {
      expect(renditionSources(other, 1600), other).toBeNull();
    }
    expect(renditionSources(url, null)).toBeNull();
    expect(renditionSources(url, 0)).toBeNull();
  });
});
