import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LegalBody } from './legal-body';

/** The real component, rendered to the HTML a browser would receive. Hostile html must come out inert. */
const render = (html: string): string => renderToStaticMarkup(createElement(LegalBody, { html }));

const PAYLOADS = [
  '<script>alert(1)</script><p>after</p>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="https://ok.example" onclick="alert(1)">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<svg onload=alert(1)></svg>',
  '<p style="x:expression(alert(1))">x</p>',
  '<form action="https://evil.example"><input name=card></form>',
  '"><script>alert(1)</script>',
  '<ul>'.repeat(10) + '<li>deep',
];

describe('LegalBody (the one place legal html enters a page)', () => {
  for (const payload of PAYLOADS) {
    it(`renders ${JSON.stringify(payload.slice(0, 40))} inert`, () => {
      const out = render(payload);
      expect(out).not.toMatch(
        /<script|<iframe|<svg|<img|<form|<input|\son[a-z]+=|javascript:|style=/i,
      );
    });
  }

  it('keeps the allowed markup and puts rel on every link', () => {
    const out = render('<h2>T</h2><p>a <a href="https://ok.example/x">l</a></p>');
    expect(out).toContain('<h2>T</h2>');
    expect(out).toContain('<a href="https://ok.example/x" rel="noopener noreferrer">l</a>');
  });

  it('renders an empty body, never throws, for text the second pass refuses (the first pass output is longer than its input)', () => {
    // 199 990 `<` passes the first sanitise (input under the limit) and grows to 800 000 characters of `&lt;`.
    const firstPass = '&lt;'.repeat(199_990);
    expect(() => render(firstPass)).not.toThrow();
    expect(render(firstPass)).toBe(render(''));
    expect(() => render('<'.repeat(199_990))).not.toThrow();
    expect(() => render('<ul>'.repeat(5_000))).not.toThrow();
    expect(render('<ul>'.repeat(5_000))).toBe(render(''));
  });
});
