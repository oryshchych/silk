import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { can, ROLES } from '../../../../../packages/core/src/auth/permissions';
import {
  acceptanceCheckDto,
  contentFieldValues,
  contentLocaleValues,
  findingCodeValues,
  photoIssueValues,
  type ContentReadinessDto,
} from '@store/shared/dto/content-readiness';

import en from '../../../messages/en.json';
import uk from '../../../messages/uk.json';
import { makeTranslator } from '../../lib/admin/message-lookup';

import { ContentReadinessView } from './content-readiness-view';

const ID = '0193f0a4-7c3e-7000-8000-000000000001';
const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';

const t = (key: string, values?: Record<string, string | number>): string =>
  `${key}${values === undefined ? '' : JSON.stringify(values)}`;

const report = (): ContentReadinessDto => ({
  generatedAt: '2026-11-27T10:00:00.000Z',
  expectedActive: 40,
  totals: {
    products: 2,
    live: 1,
    liveReady: 1,
    active: 2,
    activeReady: 1,
    drafts: 0,
    draftsReady: 0,
    categories: 1,
    categoriesReady: 0,
    photos: 1,
    photosWithProblems: 1,
  },
  acceptance: [{ id: 'active_products', ok: false, actual: 1, expected: 40 }],
  gatePassed: false,
  show: 'todo',
  page: 1,
  pageSize: 100,
  pages: 3,
  matchingProducts: 250,
  products: [
    {
      id: ID,
      sku: HOSTILE,
      slug: 'x',
      nameUk: HOSTILE,
      nameEn: HOSTILE,
      isActive: true,
      live: false,
      ready: false,
      photoCount: 0,
      activeVariantCount: 0,
      findings: [{ code: 'no_photo', severity: 'blocker', field: null, locale: null, count: null }],
    },
  ],
  productsTruncated: false,
  categories: [
    {
      id: ID,
      slug: HOSTILE,
      nameUk: HOSTILE,
      nameEn: HOSTILE,
      isActive: true,
      noindex: false,
      liveProductCount: 0,
      seoTextLengthUk: 0,
      seoTextLengthEn: 0,
      ready: false,
      findings: [
        { code: 'missing', severity: 'blocker', field: 'seo_text', locale: 'uk', count: null },
      ],
    },
  ],
  photoProblems: [
    {
      imageId: ID,
      productId: ID,
      productSku: HOSTILE,
      width: 10,
      height: 10,
      issues: ['too_narrow'],
    },
  ],
  photoProblemsTruncated: false,
});

const html = (over: Partial<ContentReadinessDto> = {}): string =>
  renderToStaticMarkup(
    createElement(ContentReadinessView, { report: { ...report(), ...over }, t }),
  );

describe('ContentReadinessView', () => {
  it('escapes every staff-entered value (sku, names, category and photo rows)', () => {
    const out = html();
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });
  it('links the editor by the product id only', () => {
    const links = [...html().matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toContain(`/admin/products/${ID}`);
    for (const link of links) expect(link).toMatch(/^\/admin\/[a-z0-9/?=&;-]+$/);
  });
  it('shows the verdict and states blockers as text, not by colour alone', () => {
    const out = html();
    expect(out).toContain('gateFail');
    expect(out).toContain('severity.blocker');
  });
  it('shows how many products the filter matches and pages through them', () => {
    const out = html({ page: 2 });
    expect(out).toContain('matching{&quot;count&quot;:250}');
    expect(out).toContain('/admin/content-readiness?show=todo&amp;page=1');
    expect(out).toContain('/admin/content-readiness?show=todo&amp;page=3');
    expect(html({ pages: 1 })).not.toContain('pageOf');
  });
  it('offers a refresh and says when the count was made', () => {
    const out = html();
    expect(out).toContain('/admin/content-readiness?refresh=1');
    expect(out).toContain('2026-11-27T10:00:00.000Z');
  });
  it('carries no cost or price wording', () => {
    expect(html()).not.toMatch(/cost|price/i);
  });
});

describe('who may open the screen: the existing admin.view permission', () => {
  it('every admin role, nobody else', () => {
    for (const role of ROLES) expect(can(role, 'admin.view')).toBe(true);
  });
});

describe('every label the screen can ask for exists in both languages', () => {
  const keys = [
    ...findingCodeValues.map((code) => `findings.${code}`),
    ...contentFieldValues.map((field) => `fields.${field}`),
    ...contentLocaleValues.map((locale) => `locale.${locale}`),
    ...photoIssueValues.map((issue) => `photoIssue.${issue}`),
    ...acceptanceCheckDto.shape.id.options.map((id) => `check.${id}`),
    ...['blocker', 'warning'].map((severity) => `severity.${severity}`),
    ...['todo', 'all', 'drafts'].map((mode) => `show.${mode}`),
    ...['stateLive', 'stateNotLive', 'stateDraft', 'ready', 'noIssues', 'ok', 'notMet'],
  ];
  for (const [locale, messages] of [
    ['uk', uk],
    ['en', en],
  ] as const) {
    it(`${locale}: no key falls back to its path`, () => {
      const t = makeTranslator(messages, 'admin.contentReadiness');
      const missing = keys.filter((key) => t(key) === `admin.contentReadiness.${key}`);
      expect(missing).toEqual([]);
    });
  }
});

describe('the screen asks for the permission itself', () => {
  it("the page calls requirePermission('admin.view') before it reads anything", () => {
    const page = readFileSync(
      new URL('../../app/admin/(shell)/content-readiness/page.tsx', import.meta.url),
      'utf8',
    );
    expect(page.indexOf("requirePermission('admin.view')")).toBeGreaterThan(-1);
    expect(page.indexOf("requirePermission('admin.view')")).toBeLessThan(
      page.indexOf('shared.get('),
    );
  });
});
