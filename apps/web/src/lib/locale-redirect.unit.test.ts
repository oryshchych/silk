import { describe, expect, it } from 'vitest';

import { stripDefaultLocalePrefix } from './locale-redirect';

describe('stripDefaultLocalePrefix', () => {
  it('maps /uk and /uk/... to the unprefixed path', () => {
    expect(stripDefaultLocalePrefix('/uk')).toBe('/');
    expect(stripDefaultLocalePrefix('/uk/category/bras')).toBe('/category/bras');
  });

  it('ignores other paths, including look-alikes', () => {
    expect(stripDefaultLocalePrefix('/')).toBeNull();
    expect(stripDefaultLocalePrefix('/en/category')).toBeNull();
    expect(stripDefaultLocalePrefix('/ukulele')).toBeNull();
    expect(stripDefaultLocalePrefix('/category/uk')).toBeNull();
  });
});
