import { describe, expect, it } from 'vitest';

import { money } from './money';
import {
  DESCRIPTION_MAX,
  FACEBOOK_COLUMNS,
  facebookCsvHeader,
  facebookCsvRow,
  feedText,
  GOOGLE_FEED_CLOSE,
  googleFeedOpen,
  googleItemXml,
  TITLE_MAX,
  validGtin,
  type FeedItem,
} from './product-feed';

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: 'AUR-75B-BLK',
  groupId: '0190a1b2-0000-7000-8000-000000000001',
  title: 'Бюстгальтер «Аврора»',
  description: 'М’який бюстгальтер',
  link: 'https://shop.example/product/aurora',
  imageLink: 'https://media.example/a.jpg',
  additionalImages: ['https://media.example/b.jpg'],
  inStock: true,
  price: money(129_900),
  salePrice: null,
  brand: 'Aurelia',
  gtin: null,
  mpn: 'AUR-75B-BLK',
  size: '75B',
  color: 'Чорний',
  productType: 'Білизна > Бюстгальтери',
  ...over,
});

/** The attributes Google Merchant Center requires on every item of a product feed. */
const REQUIRED = ['id', 'title', 'description', 'link', 'image_link', 'availability', 'price'];

/** A small well-formedness check: every tag opened is closed in order (no XML library needed). */
function balanced(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing === '/' || name === undefined) continue;
    if (closing === '/') {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}

describe('google feed', () => {
  it('writes a well-formed item with every required attribute and the group id', () => {
    const xml =
      googleFeedOpen({ title: 'S', link: 'https://shop.example', description: 'S' }) +
      googleItemXml(item()) +
      GOOGLE_FEED_CLOSE;
    expect(balanced(xml)).toBe(true);
    for (const name of REQUIRED) expect(xml, name).toMatch(new RegExp(`<(g:)?${name}>[^<]+</`));
    expect(xml).toContain(
      '<g:item_group_id>0190a1b2-0000-7000-8000-000000000001</g:item_group_id>',
    );
    expect(xml).toContain('<g:gender>female</g:gender>');
    expect(xml).toContain('<g:age_group>adult</g:age_group>');
    // Brand plus mpn identify the item: `identifier_exists` must not say otherwise.
    expect(xml).not.toContain('identifier_exists');
  });

  it('converts kopiykas to hryvnias once, with integer arithmetic only', () => {
    const xml = googleItemXml(item({ price: money(129_900) }));
    expect(xml).toContain('<g:price>1299.00 UAH</g:price>');
    expect(googleItemXml(item({ price: money(5) }))).toContain('<g:price>0.05 UAH</g:price>');
    expect(googleItemXml(item({ price: money(99_999) }))).toContain(
      '<g:price>999.99 UAH</g:price>',
    );
  });

  it('puts the regular price in price and the current one in sale_price', () => {
    const xml = googleItemXml(item({ price: money(159_900), salePrice: money(129_900) }));
    expect(xml).toContain('<g:price>1599.00 UAH</g:price>');
    expect(xml).toContain('<g:sale_price>1299.00 UAH</g:sale_price>');
    expect(googleItemXml(item())).not.toContain('sale_price');
  });

  it('reports availability from the variant', () => {
    expect(googleItemXml(item({ inStock: false }))).toContain(
      '<g:availability>out_of_stock</g:availability>',
    );
    expect(googleItemXml(item({ inStock: true }))).toContain(
      '<g:availability>in_stock</g:availability>',
    );
  });

  it('escapes hostile text in every field and keeps the document well formed', () => {
    const evil = '</title><script>alert(1)</script> & "x" \u0000\u0008';
    const xml = googleItemXml(
      item({
        title: evil,
        description: evil,
        brand: evil,
        color: evil,
        size: evil,
        productType: evil,
        link: 'https://s.example/a?b=1&c=2',
      }),
    );
    expect(xml).not.toContain('<script>');
    expect(xml).not.toMatch(/[\u0000-\u0008]/);
    expect(xml).toContain('a?b=1&amp;c=2');
    expect(
      balanced(
        googleFeedOpen({ title: 'S', link: 'l', description: 'd' }) + xml + GOOGLE_FEED_CLOSE,
      ),
    ).toBe(true);
  });

  it('cuts the title and the description on a code point, never in the middle of a pair', () => {
    const long = '😀'.repeat(TITLE_MAX + 20);
    const cut = feedText(long, TITLE_MAX);
    expect(Array.from(cut).length).toBe(TITLE_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(Array.from(feedText('x'.repeat(DESCRIPTION_MAX + 5), DESCRIPTION_MAX)).length).toBe(
      DESCRIPTION_MAX,
    );
  });

  it('keeps a GTIN only when it is a real length, otherwise says there is none', () => {
    expect(validGtin('4006381333931')).toBe('4006381333931');
    for (const bad of ['123', 'abc', '40063813339311234', '4006381 333931', null])
      expect(validGtin(bad)).toBeNull();
    expect(googleItemXml(item({ gtin: '4006381333931' }))).toContain(
      '<g:gtin>4006381333931</g:gtin>',
    );
  });

  it('writes no private field: the item type has no cost and no stock', () => {
    const xml = googleItemXml(item());
    expect(xml).not.toMatch(/cost|stock_quantity|reserved/i);
  });

  it('caps the extra photos at 10 and omits image_link when there is no photo', () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://m.example/${String(i)}.jpg`);
    expect(
      googleItemXml(item({ additionalImages: many })).match(/additional_image_link/g),
    ).toHaveLength(20);
    expect(googleItemXml(item({ imageLink: null, additionalImages: [] }))).not.toContain(
      'image_link',
    );
  });
});

describe('facebook csv: formulas', () => {
  const cellsOf = (over: Partial<FeedItem>): Record<(typeof FACEBOOK_COLUMNS)[number], string> => {
    const cells = parseLine(facebookCsvRow(item(over)).trim());
    return Object.fromEntries(FACEBOOK_COLUMNS.map((c, i) => [c, cells[i] ?? ''])) as Record<
      (typeof FACEBOOK_COLUMNS)[number],
      string
    >;
  };

  it('neutralises a free-text cell that would run as a formula, in every text column', () => {
    for (const evil of ['=HYPERLINK("http://evil","x")', '+SUM(1)', '-2+3', '@desc']) {
      const cells = cellsOf({
        title: evil,
        description: evil,
        brand: evil,
        productType: evil,
        size: evil,
        color: evil,
      });
      for (const column of [
        'title',
        'description',
        'brand',
        'product_type',
        'size',
        'color',
      ] as const) {
        expect(cells[column], `${column}: ${evil}`).toBe(`'${evil}`);
      }
    }
  });

  it('leaves ids, prices, links and GTINs alone so they keep matching the catalog', () => {
    const cells = cellsOf({ id: '-A1', mpn: '-A1', gtin: '4006381333931' });
    expect(cells.id).toBe('-A1');
    expect(cells.mpn).toBe('-A1');
    expect(cells.price).toBe('1299.00 UAH');
    expect(cells.gtin).toBe('4006381333931');
    expect(cells.link.startsWith('https://')).toBe(true);
  });

  it('does not touch text that merely contains the characters', () => {
    expect(cellsOf({ title: 'Set = bra + brief' }).title).toBe('Set = bra + brief');
  });
});

describe('facebook csv', () => {
  it('every row has exactly the header columns, even with commas, quotes and newlines in text', () => {
    const rows = [item(), item({ title: 'A, "B"\nC', description: 'x,y', color: 'a"b' })];
    for (const r of rows) {
      const line = facebookCsvRow(r);
      expect(line.endsWith('\r\n')).toBe(true);
      expect(line.slice(0, -2)).not.toMatch(/[\r\n]/);
      expect(parseLine(line.slice(0, -2))).toHaveLength(FACEBOOK_COLUMNS.length);
    }
    expect(facebookCsvHeader().trim().split(',')).toEqual([...FACEBOOK_COLUMNS]);
    expect(facebookCsvHeader().charCodeAt(0)).not.toBe(0xfeff);
  });

  it('uses the Meta spelling of availability and the same price rule', () => {
    const cells = parseLine(
      facebookCsvRow(
        item({ inStock: false, price: money(159_900), salePrice: money(129_900) }),
      ).trim(),
    );
    const at = (name: (typeof FACEBOOK_COLUMNS)[number]): string =>
      cells[FACEBOOK_COLUMNS.indexOf(name)] ?? '';
    expect(at('availability')).toBe('out of stock');
    expect(at('price')).toBe('1599.00 UAH');
    expect(at('sale_price')).toBe('1299.00 UAH');
    expect(at('item_group_id')).toBe('0190a1b2-0000-7000-8000-000000000001');
  });
});

/** RFC 4180 line splitter for the assertions (one logical line, quotes doubled). */
function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"' && line.charAt(i + 1) === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}
