import { describe, expect, it } from 'vitest';

import { markdownToHtml, safeHref, sanitizeHtml } from './rich-text';

/** Real-world payloads: each must come out with no executable markup. */
const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="jav&#x61;script:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="//evil.example/phish">x</a>',
  '<a href="\\\\evil.example">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="x.swf"></object><embed src="x.swf">',
  '<form action="https://evil.example"><input name=card></form>',
  '<style>body{background:url(javascript:alert(1))}</style>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<p onclick="alert(1)">x</p>',
  '<body onload=alert(1)>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel=stylesheet href=//evil.example/x.css>',
  '<base href="//evil.example/">',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<<script>alert(1);//<</script>',
  '<img src="x"\nonerror="alert(1)">',
  '<details open ontoggle=alert(1)>',
  '<a href="https://ok.example" onmouseover="alert(1)">x</a>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<textarea><script>alert(1)</script></textarea>',
  '<template><script>alert(1)</script></template>',
  '"><script>alert(1)</script>',
  '<p>unterminated <a href="https://ok.example',
];

const EXECUTABLE =
  /<script|<iframe|<object|<embed|<form|<style|<svg|<math|<img|<meta|<link|<base|<body|<details|<input|<textarea|<template|\son[a-z]+\s*=|javascript:|vbscript:|data:text|style\s*=|srcdoc/i;

describe('sanitizeHtml: XSS corpus', () => {
  for (const payload of XSS_CORPUS) {
    it(`neutralises ${JSON.stringify(payload.slice(0, 48))}`, () => {
      const clean = sanitizeHtml(payload);
      // The tags that remain are allowlisted ones; no attribute other than a vetted href survives.
      expect(clean).not.toMatch(EXECUTABLE);
      for (const tag of clean.matchAll(/<([a-z0-9]+)([^>]*)>/g)) {
        expect(['p', 'a', 'strong', 'em', 'b', 'i', 'br', 'hr', 'ul', 'ol', 'li']).toContain(
          tag[1],
        );
        if (tag[1] !== 'a') expect(tag[2]).toBe('');
      }
      // Idempotent: a second pass changes nothing, so write-time and render-time agree.
      expect(sanitizeHtml(clean)).toBe(clean);
    });
  }

  it('keeps the allowed markup and adds rel to links', () => {
    expect(
      sanitizeHtml(
        '<p>Hi <strong>there</strong> <a href="https://shop.example/a?b=1&amp;c=2">link</a></p>',
      ),
    ).toBe(
      '<p>Hi <strong>there</strong> <a href="https://shop.example/a?b=1&amp;c=2" rel="noopener noreferrer">link</a></p>',
    );
  });

  it('closes what was left open and drops what was never opened', () => {
    expect(sanitizeHtml('<ul><li>one</li></p><li>two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('drops a link without a safe target but keeps its text', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });

  it('escapes a stray angle bracket and an unknown entity', () => {
    expect(sanitizeHtml('1 < 2 & 3 > 2')).toBe('1 &lt; 2 &amp; 3 &gt; 2');
  });

  it('refuses text that is far too long and nesting that is far too deep', () => {
    expect(() => sanitizeHtml('a'.repeat(300_000))).toThrow(RangeError);
    expect(() => sanitizeHtml('<ul>'.repeat(60))).toThrow(RangeError);
  });
});

describe('safeHref', () => {
  it('accepts https, http, mailto, tel and site paths', () => {
    for (const value of [
      'https://shop.example/x',
      'http://shop.example',
      'mailto:hi@shop.example',
      'tel:+380441234567',
      '/legal/returns',
    ]) {
      expect(safeHref(value)).toBe(value);
    }
  });

  it('refuses everything else', () => {
    for (const value of [
      '',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://x.example',
      '//evil.example',
      'relative/path',
      'https://',
      'https://a.example/"onmouseover="x',
      'https://a.example/\u0000',
    ]) {
      expect(safeHref(value)).toBeNull();
    }
  });
});

describe('markdownToHtml', () => {
  it('renders headings, paragraphs, lists, emphasis and links', () => {
    const html = markdownToHtml(
      [
        '## Title',
        '',
        'Some **bold** and *italic* text,',
        'continued [here](https://shop.example/a).',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
      ].join('\n'),
    );
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain(
      '<p>Some <strong>bold</strong> and <em>italic</em> text, continued <a href="https://shop.example/a" rel="noopener noreferrer">here</a>.</p>',
    );
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('turns every XSS payload into text: the source can never write a tag', () => {
    for (const payload of XSS_CORPUS) {
      const html = markdownToHtml(payload);
      // What is left of the payload is escaped TEXT: the only raw `<` are the tags the renderer wrote.
      expect(
        html.replace(/<\/?(?:p|a|strong|em)(?: href="[^"]*" rel="noopener noreferrer")?>/g, ''),
      ).not.toContain('<');
      expect(html).not.toMatch(/<a [^>]*(?:javascript|data):/i);
      expect(html.startsWith('<p>')).toBe(true);
    }
  });

  it('drops an unsafe Markdown link and keeps its label as text', () => {
    expect(markdownToHtml('[click](javascript:alert(1))')).toBe('<p>click)</p>');
    expect(markdownToHtml('[x](https://a.example/"onerror="y)')).not.toContain('onerror="');
  });

  it('is deterministic', () => {
    const source = '## A\n\ntext & more <b>';
    expect(markdownToHtml(source)).toBe(markdownToHtml(source));
    expect(markdownToHtml(source)).toBe('<h2>A</h2>\n<p>text &amp; more &lt;b&gt;</p>');
  });
});
