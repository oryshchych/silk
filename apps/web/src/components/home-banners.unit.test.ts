import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PublicBannerDto } from '@store/shared/dto/banner';

import { HomeBanners } from './home-banners';

const ID = '0190a1b2-0000-7000-8000-000000000001';
const IMG = '0190a1b2-0000-7000-8000-0000000000aa';
const base = `https://media.shop.example/banners/${ID}/${IMG}`;
const banner = (overrides: Partial<PublicBannerDto> = {}): PublicBannerDto => ({
  id: ID,
  title: 'Spring <b>sale</b>',
  subtitle: null,
  ctaLabel: 'Shop',
  href: '/category/bras',
  alt: 'Spring collection',
  desktop: { url: `${base}/full.webp`, width: 2400, height: 800 },
  mobile: { url: `${base}/full.webp`, width: 800, height: 1000 },
  ...overrides,
});
const render = (banners: PublicBannerDto[], locale: 'uk' | 'en' = 'uk') =>
  renderToStaticMarkup(createElement(HomeBanners, { banners, locale, label: 'Promotions' }));

describe('HomeBanners', () => {
  it('renders nothing when no banner is shown (no empty section)', () => {
    expect(render([])).toBe('');
  });

  it('one picture element with mobile and desktop sources, a reserved box, alt text and an escaped title', () => {
    const html = render([banner()]);
    expect(html).toContain('media="(max-width: 767px)"');
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('width="2400"');
    expect(html).toContain('height="800"');
    expect(html).toContain('alt="Spring collection"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('Spring &lt;b&gt;sale&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('href="/category/bras"');
  });

  it('every <source> carries the size of ITS OWN picture (mobile on mobile sources, desktop on the rest)', () => {
    const html = render([banner()]);
    const sources = html.match(/<source[^>]*>/g) ?? [];
    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const source of sources) {
      expect(source, source).toMatch(/width="\d+"/);
      expect(source, source).toMatch(/height="\d+"/);
      if (source.includes('media="(max-width: 767px)"')) {
        expect(source).toContain('width="800"');
        expect(source).toContain('height="1000"');
      } else {
        expect(source).toContain('width="2400"');
        expect(source).toContain('height="800"');
      }
    }
  });

  it('the title is a paragraph, never a heading above the page h1', () => {
    expect(render([banner()])).not.toMatch(/<h[1-6]/);
  });

  it('only the first banner is the LCP candidate; the rest are lazy', () => {
    const html = render([banner(), banner({ id: '0190a1b2-0000-7000-8000-000000000002' })]);
    expect(html.match(/fetchPriority="high"/g)).toHaveLength(1);
    expect(html.match(/loading="lazy"/g)).toHaveLength(1);
  });

  it('is a pure function of the data and the locale: the same input is the same bytes (nothing about a visitor)', () => {
    expect(render([banner()])).toBe(render([banner()]));
    expect(render([banner()], 'en')).toContain('href="/en/category/bras"');
  });

  it('a banner without a link is not a link', () => {
    expect(render([banner({ href: null })])).not.toContain('<a ');
  });
});
