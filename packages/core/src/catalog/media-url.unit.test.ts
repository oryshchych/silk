import { describe, expect, it } from 'vitest';

import { safeMediaUrl } from './media-url';

describe('safeMediaUrl', () => {
  it('accepts https URLs and site-relative paths', () => {
    expect(safeMediaUrl('https://cdn.example/a.webp')).toBe('https://cdn.example/a.webp');
    expect(safeMediaUrl('/placeholder.svg')).toBe('/placeholder.svg');
    expect(safeMediaUrl('  https://cdn.example/a b'.replace(' b', ''))).toBe(
      'https://cdn.example/a',
    );
  });

  it('rejects every other scheme, protocol-relative URLs and junk', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://cdn.example/a.webp',
      '//evil.example/x.png',
      '/\\evil.example',
      'ftp://x/y',
      'https://',
      'cdn.example/a.webp',
      'https://cdn.example/a"onerror="x',
      'https://cdn.example/a\u0000b',
      '',
      '   ',
    ]) {
      expect(safeMediaUrl(bad)).toBeNull();
    }
    expect(safeMediaUrl(null)).toBeNull();
  });
});
