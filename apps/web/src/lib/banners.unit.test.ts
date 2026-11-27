import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The cache-safe design of the banners (see `banners.ts`): they are read and rendered on the home page only. A page
 * that is stored and shared by all visitors (the ISR product and category pages) must never import them: a banner
 * change or a period boundary could then make such a page differ between visitors or go stale.
 */
const APP = join(import.meta.dirname, '..', 'app', '[locale]');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('banners stay off the stored pages', () => {
  it('the product and category routes do not import the banner loader or component', () => {
    const files = [...sources(join(APP, 'product')), ...sources(join(APP, 'category'))];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/lib\/banners|home-banners|BANNERS_TAG/);
    }
  });

  it('the loader reads nothing about the visitor', () => {
    const source = readFileSync(join(import.meta.dirname, 'banners.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/cookies\(|headers\(|searchParams|session|x-forwarded/i);
    expect(code).toMatch(/\['banners', locale\]/);
  });
});
