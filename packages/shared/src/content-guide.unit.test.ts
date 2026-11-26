import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CONTENT_BOUNDS, PHOTO_BOUNDS } from './content-bounds';
import { BASIC_COLUMNS, CONTENT_COLUMNS } from './content-columns';

const guide = readFileSync(new URL('../../../docs/CONTENT_GUIDE.md', import.meta.url), 'utf8');

/** The guide quotes the numbers of the tools: when one changes, the guide must follow. */
describe('docs/CONTENT_GUIDE.md agrees with the tools', () => {
  it('names every import column', () => {
    for (const column of BASIC_COLUMNS) expect(guide).toContain(`\`${column}\``);
    const bases = new Set(CONTENT_COLUMNS.map((c) => c.column.replace(/_(uk|en)$/, '')));
    for (const base of bases) expect(guide).toContain(`\`${base}`);
  });

  it('quotes every text bound as "min to max"', () => {
    for (const [name, bound] of Object.entries(CONTENT_BOUNDS))
      expect([name, guide.includes(`${String(bound.min)} to ${String(bound.max)}`)]).toEqual([
        name,
        true,
      ]);
  });

  it('quotes the photo rules', () => {
    expect(guide).toContain(`${String(PHOTO_BOUNDS.minWidth)} px`);
    expect(guide).toContain(`${String(PHOTO_BOUNDS.maxBytes / 1024 / 1024)} MB`);
    expect(guide).toContain(`${String(PHOTO_BOUNDS.maxPixels / 1_000_000)} megapixels`);
    expect(guide).toContain('12 000 px');
  });

  it('cites only owner queue entries that exist', () => {
    const queue = readFileSync(
      new URL('../../../docs/plan/OWNER_QUEUE.md', import.meta.url),
      'utf8',
    );
    for (const id of new Set(guide.match(/\bQ\d+\b/g) ?? []))
      expect([id, new RegExp(`\\| ${id} \\|`).test(queue)]).toEqual([id, true]);
  });

  it('lists the five acceptance checks', () => {
    expect(guide).toContain('The gate passes when all five hold');
  });
});
