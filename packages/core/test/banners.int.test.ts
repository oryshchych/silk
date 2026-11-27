/**
 * Banners on real Postgres (phase 11, slice D): drafts without pictures, activation only when complete (the action's
 * check AND the database CHECK), the public read decided by the database clock, an internal link only, the public
 * shape without any admin field, and the language picked per locale.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import {
  bannerKeysOfUrl,
  MAX_BANNERS,
  bannerCreateSchema,
  bannerUpdateSchema,
  BannerIncompleteError,
  createBanner,
  deleteBanner,
  HOME_BANNER_LIMIT,
  listActiveBanners,
  listBannersAdmin,
  setBannerImage,
  updateBanner,
} from '../src/banners/index.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
});
afterEach(async () => {
  await world.close();
});

const form = (overrides: Record<string, unknown> = {}) => ({
  titleUk: 'Весна',
  titleEn: 'Spring',
  subtitleUk: '',
  subtitleEn: '',
  ctaLabelUk: 'Дивитись',
  ctaLabelEn: 'Shop',
  altUk: 'Весняна колекція',
  altEn: 'Spring collection',
  href: '/category/bras',
  startsAt: '',
  endsAt: '',
  sortOrder: '0',
  isActive: false,
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await admin.db.transaction(
    async (tx) => await createBanner(tx, bannerCreateSchema.parse(form(overrides))),
  );
  return row.id;
}
async function pictures(id: string): Promise<void> {
  for (const slot of ['desktop', 'mobile'] as const) {
    await admin.db.transaction(
      async (tx) =>
        await setBannerImage(tx, {
          bannerId: id,
          slot,
          url: `https://media.test/banners/${id}/00000000-0000-4000-8000-0000000000aa/full.webp`,
          width: slot === 'desktop' ? 1600 : 800,
          height: slot === 'desktop' ? 600 : 1000,
        }),
    );
  }
}
const update = async (id: string, overrides: Record<string, unknown>) =>
  await admin.db.transaction(
    async (tx) => await updateBanner(tx, bannerUpdateSchema.parse({ ...form(overrides), id })),
  );

describe('input', () => {
  it('a link is a path on this shop; anything else is refused', () => {
    for (const href of [
      'https://evil.example',
      '//evil.example',
      'javascript:alert(1)',
      '/ x',
      '/',
      'category',
    ]) {
      expect(bannerCreateSchema.safeParse(form({ href })).success, href).toBe(false);
    }
    for (const href of ['/category/bras', '/product/x?color=red', '']) {
      expect(bannerCreateSchema.safeParse(form({ href })).success, href).toBe(true);
    }
    expect(
      bannerCreateSchema.safeParse(
        form({ startsAt: '2030-01-02T10:00', endsAt: '2030-01-01T10:00' }),
      ).success,
    ).toBe(false);
  });
});

describe('completeness', () => {
  it('a banner is born inactive; it cannot be switched on without both pictures and alt text', async () => {
    await expect(create({ isActive: true })).rejects.toBeInstanceOf(BannerIncompleteError);
    const id = await create();
    await expect(update(id, { isActive: true })).rejects.toBeInstanceOf(BannerIncompleteError);
    await admin.db.transaction(
      async (tx) =>
        await setBannerImage(tx, {
          bannerId: id,
          slot: 'desktop',
          url: `https://media.test/banners/${id}/00000000-0000-4000-8000-0000000000aa/full.webp`,
          width: 1600,
          height: 600,
        }),
    );
    await expect(update(id, { isActive: true })).rejects.toBeInstanceOf(BannerIncompleteError);
    await pictures(id);
    await expect(update(id, { isActive: true, altEn: '' })).rejects.toBeInstanceOf(
      BannerIncompleteError,
    );
    expect((await update(id, { isActive: true })).changed).toBe(true);
    expect((await update(id, { isActive: true })).changed).toBe(false);
  });

  it('the database refuses an incomplete active banner even when the action is bypassed', async () => {
    const id = await create();
    await expect(
      admin.db.execute(sql`UPDATE banners SET is_active = true WHERE id = ${id}::uuid`),
    ).rejects.toThrow();
  });
});

describe('the public read', () => {
  async function shown(locale: 'uk' | 'en' = 'uk'): Promise<string[]> {
    return (await listActiveBanners(admin.db, locale)).map((b) => b.title ?? '');
  }
  async function live(title: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = await create({
      titleUk: title,
      titleEn: `${title}-en`,
      ...overrides,
      isActive: false,
    });
    await pictures(id);
    await update(id, { titleUk: title, titleEn: `${title}-en`, ...overrides, isActive: true });
    return id;
  }

  it('shows only active, complete banners inside their period, by the database clock, in order', async () => {
    await live('B-late', { sortOrder: '5' });
    await live('A-first', { sortOrder: '1' });
    await live('future', { startsAt: '2099-01-01T10:00' });
    await live('past', { endsAt: '2000-01-01T10:00' });
    await create({ titleUk: 'draft' });
    const off = await live('off');
    await update(off, { titleUk: 'off', titleEn: 'off-en', isActive: false });
    expect(await shown()).toEqual(['A-first', 'B-late']);
    expect(await shown('en')).toEqual(['A-first-en', 'B-late-en']);
    // The period is Postgres' now(): a banner whose end passes drops out without any write.
    const ends = await live('ending', { sortOrder: '0' });
    await admin.db.execute(
      sql`UPDATE banners SET ends_at = now() - interval '1 second', starts_at = now() - interval '1 hour' WHERE id = ${ends}::uuid`,
    );
    expect(await shown()).toEqual(['A-first', 'B-late']);
  });

  it('is capped, and the public shape holds exactly the rendered fields', async () => {
    for (let i = 0; i < HOME_BANNER_LIMIT + 2; i += 1)
      await live(`n${String(i)}`, { sortOrder: String(i) });
    const list = await listActiveBanners(admin.db, 'uk');
    expect(list).toHaveLength(HOME_BANNER_LIMIT);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(
      ['alt', 'ctaLabel', 'desktop', 'href', 'id', 'mobile', 'subtitle', 'title'].sort(),
    );
    expect(JSON.stringify(list)).not.toMatch(
      /isActive|startsAt|endsAt|sortOrder|altUk|altEn|updatedAt/,
    );
  });

  it('the admin list says what is shown now, from the same rule', async () => {
    await live('now');
    await live('later', { startsAt: '2099-01-01T10:00' });
    await create({ titleUk: 'draft' });
    const rows = await listBannersAdmin(admin.db);
    expect(rows.map((r) => [r.titleUk, r.shownNow])).toEqual([
      ['now', true],
      ['later', false],
      ['draft', false],
    ]);
  });

  it('a deleted banner disappears', async () => {
    const id = await live('gone');
    await admin.db.transaction(async (tx) => {
      await deleteBanner(tx, id);
    });
    expect(await shown()).toEqual([]);
  });
});

describe('review round', () => {
  it('a whitespace-only alt text does not make a banner completable', async () => {
    const id = await create();
    await pictures(id);
    await expect(update(id, { isActive: true, altUk: '   ' })).rejects.toBeInstanceOf(
      BannerIncompleteError,
    );
    await expect(
      admin.db.execute(
        sql`UPDATE banners SET alt_uk = ' ', is_active = true WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('the audit diff of a period change holds ISO strings on both sides', async () => {
    const id = await create({ startsAt: '2030-01-02T10:00', endsAt: '2030-02-02T10:00' });
    const first = await update(id, { startsAt: '2030-01-03T10:00', endsAt: '' });
    expect(first.diff).toEqual({
      startsAt: ['2030-01-02T08:00:00Z', '2030-01-03T08:00:00Z'],
      endsAt: ['2030-02-02T08:00:00Z', null],
    });
    // Summer time: Kyiv is UTC+3.
    const second = await update(id, { startsAt: '2030-07-03T10:00', endsAt: '' });
    expect(second.diff).toEqual({ startsAt: ['2030-01-03T08:00:00Z', '2030-07-03T07:00:00Z'] });
    expect(JSON.stringify(second.diff)).not.toContain('{}');
  });

  it('the cap is exact: two creates racing for the last place make one banner', async () => {
    await admin.db.execute(
      sql`INSERT INTO banners (is_active) SELECT false FROM generate_series(1, ${MAX_BANNERS - 1})`,
    );
    const results = await Promise.allSettled([
      world
        .connect()
        .db.transaction(async (tx) => await createBanner(tx, bannerCreateSchema.parse(form()))),
      world
        .connect()
        .db.transaction(async (tx) => await createBanner(tx, bannerCreateSchema.parse(form()))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const count = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM banners`,
    );
    expect(count.rows[0]?.n).toBe(MAX_BANNERS);
  });

  it('keys are rebuilt from the two ids of a stored URL, and nothing else yields keys', () => {
    const banner = '00000000-0000-4000-8000-0000000000b1';
    const image = '00000000-0000-4000-8000-0000000000a1';
    const keys = bannerKeysOfUrl(`https://media.test/banners/${banner}/${image}/full.webp`);
    expect(keys).toHaveLength(6);
    expect(keys).toContain(`banners/${banner}/${image}/thumb.avif`);
    for (const url of [
      null,
      '',
      'https://x/products/a/b/full.webp',
      `https://media.test/banners/../${image}/full.webp`,
    ]) {
      expect(bannerKeysOfUrl(url)).toEqual([]);
    }
  });
});
