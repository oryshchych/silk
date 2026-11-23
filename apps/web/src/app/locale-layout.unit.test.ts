import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Canonical and hreflang read the RUNTIME SITE_URL (ADR-10). That holds only
 * while nothing under `[locale]` is prerendered at build time: a
 * `generateStaticParams` there would bake the build host into every URL.
 */
describe('locale layout', () => {
  it('has no generateStaticParams', () => {
    const source = readFileSync(new URL('./[locale]/layout.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+generateStaticParams/);
  });
});
