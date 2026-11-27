import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The blog pages are the same for every visitor: nothing about the visitor (cookie, header, session, address) may enter
 * the blog loader or the blog routes, and a cache key is built from a locale, a checked word and a clamped page only.
 */
const SRC = join(import.meta.dirname, '..');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe('blog pages are visitor-independent', () => {
  const files = [
    join(SRC, 'lib', 'blog.ts'),
    join(SRC, 'components', 'blog-list.tsx'),
    ...sources(join(SRC, 'app', '[locale]', 'blog')),
  ];

  it('no blog file reads a cookie, a header, a session or the client address', () => {
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, file).not.toMatch(/cookies\(|headers\(|session|x-forwarded|userAgent/i);
    }
  });

  it('the post page is ISR and carries no per-request API', () => {
    const page = readFileSync(join(SRC, 'app', '[locale]', 'blog', '[slug]', 'page.tsx'), 'utf8');
    expect(page).toMatch(/export const revalidate = 300/);
    expect(page).not.toMatch(/searchParams|force-dynamic/);
  });

  it('the proxy gates blog addresses by the shape and the known set before the route', () => {
    const proxy = readFileSync(join(SRC, 'proxy.ts'), 'utf8');
    expect(proxy).toContain('knownBlogPages.has');
    expect(proxy).toContain('blogGateKey');
  });
});
