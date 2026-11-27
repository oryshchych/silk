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

const SRC = join(import.meta.dirname, '..');

/** Every source file of the web app that is not a test. */
const appFiles = (): string[] => sources(SRC).filter((file) => !/\.test\.tsx?$/.test(file));

/** The files that import the banner loader or component, by the path the app uses. */
function bannerImporters(
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): string[] {
  return appFiles()
    .filter((file) => !/lib\/banners\.ts$|components\/home-banners\.tsx$/.test(file))
    .filter((file) => /from\s+['"][^'"]*(?:lib\/banners|home-banners)['"]/.test(read(file)));
}

describe('banners stay off the stored pages', () => {
  it('only the home page imports the banner loader or component: no shared component, layout or ISR page can', () => {
    expect(bannerImporters().map((file) => file.slice(SRC.length + 1))).toEqual([
      join('app', '[locale]', 'page.tsx'),
    ]);
  });

  it('a scratch import into site-shell.tsx (used by every ISR page) would fail the check', () => {
    const shell = join(SRC, 'components', 'site-shell.tsx');
    const polluted = (file: string): string =>
      file === shell
        ? `import { loadBanners } from '../lib/banners';\n${readFileSync(file, 'utf8')}`
        : readFileSync(file, 'utf8');
    expect(bannerImporters(polluted).map((file) => file.slice(SRC.length + 1))).toContain(
      join('components', 'site-shell.tsx'),
    );
  });

  it('the product and category routes do not mention banners at all', () => {
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
