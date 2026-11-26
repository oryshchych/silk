import { describe, expect, it } from 'vitest';

import { legalKindOfPath, parseLegalPath } from './legal-path';

describe('parseLegalPath', () => {
  it('knows the seven fixed words in both locales', () => {
    expect(parseLegalPath('/legal/delivery-payment')).toEqual({
      locale: 'uk',
      kind: 'delivery_payment',
    });
    expect(parseLegalPath('/en/legal/returns')).toEqual({ locale: 'en', kind: 'returns' });
  });

  it('gives a null kind to anything else, so the proxy can answer 404 before any cache entry exists', () => {
    for (const word of ['unknown', 'Terms', 'terms.html', '..%2f', 'delivery_payment', '']) {
      expect(parseLegalPath(`/legal/${word}`)?.kind ?? null).toBeNull();
    }
  });

  it('ignores other paths', () => {
    for (const path of ['/legal', '/legal/terms/extra', '/product/legal', '/en/legal/']) {
      expect(parseLegalPath(path)).toBeNull();
    }
  });
});

describe('legalKindOfPath', () => {
  it('gives the kind of a locale-less legal path and null for everything else', () => {
    expect(legalKindOfPath('/legal/about')).toBe('about');
    expect(legalKindOfPath('/legal/nope')).toBeNull();
    expect(legalKindOfPath('/category/bras')).toBeNull();
    expect(legalKindOfPath('/')).toBeNull();
  });
});
