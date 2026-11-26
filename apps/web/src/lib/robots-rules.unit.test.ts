import { describe, expect, it } from 'vitest';

import { robotsRules } from './robots-rules';

describe('robotsRules', () => {
  it('closes everything outside production and announces no sitemap', () => {
    for (const env of ['staging', 'local', 'anything-else']) {
      expect(robotsRules(env, 'https://x.example')).toEqual({
        rules: { userAgent: '*', disallow: '/' },
      });
    }
  });

  it('production closes private routes in both locales and names the sitemap index', () => {
    const result = robotsRules('production', 'https://shop.example');
    expect(result.sitemap).toBe('https://shop.example/sitemap.xml');
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rules?.disallow).toEqual(
      expect.arrayContaining([
        '/admin/',
        '/api/',
        '/cart$',
        '/cart?',
        '/en/cart$',
        '/order/',
        '/en/order/',
        '/en/search?',
      ]),
    );
    expect(rules?.allow).toBe('/');
    // A sibling that only starts like a private root stays open.
    expect(rules?.disallow).not.toContain('/cart');
    expect(rules?.disallow).not.toContain('/search');
  });
});
