import { describe, expect, it } from 'vitest';

import { processImage } from '@store/media/process';
import { masterWidth, renditionWidth } from '@store/media/widths';

import { renditionSources } from './renditions';
import { samplePhoto } from '../../../../packages/media/test/sample-image';

const ID = '0190a1b2-0000-7000-8000-000000000001';
const IMG = '0190a1b2-0000-7000-8000-0000000000aa';
const url = `https://media.shop.example/products/${ID}/${IMG}/full.webp`;
const base = `https://media.shop.example/products/${ID}/${IMG}`;

describe('renditionSources for banners', () => {
  it('banner pictures have the same rendition shape under banners/', () => {
    const banner = `https://media.shop.example/banners/${ID}/${IMG}`;
    expect(renditionSources(`${banner}/full.webp`, 3000, 1000)?.webp).toBe(
      `${banner}/thumb.webp 320w, ${banner}/card.webp 800w, ${banner}/full.webp 1600w`,
    );
    expect(
      renditionSources(`https://media.shop.example/other/${ID}/${IMG}/full.webp`, 3000, 1000),
    ).toBeNull();
  });
});

describe('renditionSources', () => {
  it('derives AVIF and WebP srcsets at the three widths from the full WebP url (a large landscape photo)', () => {
    expect(renditionSources(url, 3000, 2000)).toEqual({
      avif: `${base}/thumb.avif 320w, ${base}/card.avif 800w, ${base}/full.avif 1600w`,
      webp: `${base}/thumb.webp 320w, ${base}/card.webp 800w, ${base}/full.webp 1600w`,
    });
  });

  it('a portrait photo is narrower than 1600: the descriptors say so (the four reviewed cases)', () => {
    const full = (w: number, h: number): string | undefined =>
      /full\.webp (\d+)w/.exec(renditionSources(url, w, h)?.webp ?? '')?.[1];
    expect(full(2000, 2500)).toBe('1280');
    expect(full(3000, 4000)).toBe('1200');
    expect(full(1200, 1800)).toBe('1067');
    expect(full(1500, 2000)).toBe('1200');
    expect(renditionSources(url, 2000, 2500)?.webp).toContain('card.webp 800w');
  });

  it('never claims a width the file does not have (a small source), and drops duplicate widths', () => {
    expect(renditionSources(url, 700, 500)?.webp).toBe(
      `${base}/thumb.webp 320w, ${base}/card.webp 700w`,
    );
    expect(renditionSources(url, 200, 300)?.avif).toBe(`${base}/thumb.avif 200w`);
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
      expect(renditionSources(other, 1600, 1200), other).toBeNull();
    }
    expect(renditionSources(url, null, 1200)).toBeNull();
    expect(renditionSources(url, 1600, null)).toBeNull();
    expect(renditionSources(url, 0, 100)).toBeNull();
  });
});

describe('the derived widths equal what the converter really produces', () => {
  // Real pixels through the real pipeline: the test is not self-referential.
  for (const [width, height] of [
    [2000, 2500],
    [3000, 4000],
    [1200, 1800],
    [1500, 2000],
    [3000, 2000],
    [700, 500],
    [900, 900],
  ] as const) {
    it(`${String(width)}x${String(height)}`, async () => {
      const processed = await processImage(await samplePhoto(width, height));
      for (const rendition of processed.renditions) {
        expect(rendition.width, `${rendition.size}.${rendition.format}`).toBe(
          renditionWidth(rendition.size, width, height),
        );
      }
      expect(masterWidth(width, height)).toBeLessThanOrEqual(1600);
    });
  }
});
