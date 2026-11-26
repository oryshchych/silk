import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ResponsiveImage } from './responsive-image';

const ID = '0190a1b2-0000-7000-8000-000000000001';
const IMG = '0190a1b2-0000-7000-8000-0000000000aa';
const upload = `https://media.shop.example/products/${ID}/${IMG}/full.webp`;

const render = (props: Partial<Parameters<typeof ResponsiveImage>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(ResponsiveImage, {
      url: upload,
      alt: 'Бюстгальтер',
      width: 3000,
      height: 2000,
      sizes: '46vw',
      ...props,
    }),
  );

describe('ResponsiveImage (the real markup)', () => {
  it('an upload becomes a picture with AVIF then WebP sources and a sized fallback image', () => {
    const html = render();
    expect(html.startsWith('<picture>')).toBe(true);
    expect(html.indexOf('image/avif')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('image/avif')).toBeLessThan(html.indexOf('image/webp'));
    expect(html).toContain('320w');
    expect(html).toContain('1600w');
    expect(html).toContain('sizes="46vw"');
    expect(html).toContain(`<img src="${upload}"`);
    expect(html).toContain('width="3000"');
    expect(html).toContain('height="2000"');
    expect(html).toContain('alt="Бюстгальтер"');
    expect(html).toContain('decoding="async"');
  });

  it('is lazy by default and eager with a high fetch priority for the LCP candidate', () => {
    expect(render()).toContain('loading="lazy"');
    expect(render().toLowerCase()).not.toContain('fetchpriority');
    const lead = render({ priority: true });
    expect(lead).toContain('loading="eager"');
    // React writes the attribute as `fetchPriority`; HTML attribute names are case-insensitive.
    expect(lead).toContain('fetchPriority="high"');
  });

  it('an eager image is not the priority candidate: eager loading, no priority hint', () => {
    const html = render({ eager: true });
    expect(html).toContain('loading="eager"');
    expect(html.toLowerCase()).not.toContain('fetchpriority');
  });

  it('portrait photos describe their real widths in the markup', () => {
    expect(render({ width: 2000, height: 2500 })).toContain('full.webp 1280w');
  });

  it('a placeholder keeps the plain image, still with its box reserved, and no picture', () => {
    const html = render({ url: '/placeholder.svg', width: null, height: null });
    expect(html.startsWith('<img')).toBe(true);
    expect(html).not.toContain('<picture');
    expect(html).toContain('width="800"');
    expect(html).toContain('height="1000"');
    expect(html).not.toContain('sizes=');
  });

  it('escapes the alt text', () => {
    expect(render({ alt: '"><script>x</script>' })).not.toContain('<script>');
  });
});
