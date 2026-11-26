/**
 * The returns policy is described in FOUR places: the returns page summary (rendered here), the return form
 * (the reasons it offers), the server's check of a request (`isReasonAccepted`) and the `hasMerchantReturnPolicy`
 * JSON-LD on every product. They all come from `@store/shared/return-policy`; this test compares them, so a change
 * of the policy that reaches one place and not another fails here. Owner queue Q75.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { returnReasonValues } from '@store/shared/dto/return';
import {
  acceptedReturnReasons,
  isReasonAccepted,
  REASONS_ACCEPTED_BY_LAW,
  REASONS_VOLUNTARY,
  RETURN_POLICY,
  type ReturnPolicy,
} from '@store/shared/return-policy';
import { money } from '@store/shared/money';
import { buildMerchantReturnPolicy, buildProduct } from '@store/shared/schema-org';

import en from '../../messages/en.json';
import uk from '../../messages/uk.json';

const MESSAGES = { en, uk } as const;
const state: { locale: 'en' | 'uk' } = vi.hoisted(() => ({ locale: 'en' }));

/** `getTranslations` backed by the real message files (what the server renders), with `{name}` interpolation. */
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve((key: string, values: Record<string, unknown> = {}): string => {
      let node: unknown = MESSAGES[state.locale];
      for (const part of `${namespace}.${key}`.split('.')) {
        node =
          typeof node === 'object' && node !== null
            ? Object.entries(node).find(([k]) => k === part)?.[1]
            : undefined;
      }
      if (typeof node !== 'string')
        throw new Error(`missing message ${namespace}.${key} (${state.locale})`);
      return node.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
    }),
}));

const { ReturnPolicySummary } = await import('../components/return-policy-summary');

async function summary(locale: 'en' | 'uk', days: number): Promise<string> {
  state.locale = locale;
  return renderToStaticMarkup(await ReturnPolicySummary({ windowDays: days }));
}
const reasonsIn = (html: string, testId: string): string[] => {
  const block = new RegExp(`data-testid="${testId}">([\\s\\S]*?)</ul>`).exec(html)?.[1] ?? '';
  return [...block.matchAll(/data-reason="([a-z_]+)"/g)].map((m) => m[1] ?? '');
};

describe('the policy constants', () => {
  it('split every reason of the database enum into exactly one of two groups', () => {
    const all = [...REASONS_ACCEPTED_BY_LAW, ...REASONS_VOLUNTARY].sort();
    expect(all).toEqual([...returnReasonValues].sort());
    const voluntary: readonly string[] = REASONS_VOLUNTARY;
    expect(REASONS_ACCEPTED_BY_LAW.filter((r) => voluntary.includes(r))).toEqual([]);
  });

  it('accept the statutory reasons always, and the voluntary ones only when voluntary returns are on', () => {
    expect(acceptedReturnReasons({ voluntaryReturns: false })).toEqual([
      ...REASONS_ACCEPTED_BY_LAW,
    ]);
    expect(acceptedReturnReasons({ voluntaryReturns: true })).toEqual(
      [...returnReasonValues].sort(
        (a, b) =>
          [...REASONS_ACCEPTED_BY_LAW, ...REASONS_VOLUNTARY].indexOf(a) -
          [...REASONS_ACCEPTED_BY_LAW, ...REASONS_VOLUNTARY].indexOf(b),
      ),
    );
    expect(isReasonAccepted('defect')).toBe(true);
    expect(isReasonAccepted('changed_mind', { voluntaryReturns: false })).toBe(false);
    expect(isReasonAccepted('changed_mind', { voluntaryReturns: true })).toBe(true);
  });
});

describe('the JSON-LD says what the policy says', () => {
  it('declares returns NOT permitted for UA while voluntary returns are off, with no window, method or fees', () => {
    const ld = buildMerchantReturnPolicy(RETURN_POLICY);
    expect(RETURN_POLICY.voluntaryReturns).toBe(false);
    expect(ld).toEqual({
      '@type': 'MerchantReturnPolicy',
      applicableCountry: RETURN_POLICY.applicableCountry,
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    });
  });

  it('becomes a finite window with the shared days, method and fees when voluntary returns are on', () => {
    const on: ReturnPolicy = { ...RETURN_POLICY, voluntaryReturns: true };
    expect(buildMerchantReturnPolicy(on, 21)).toEqual({
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'UA',
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      merchantReturnDays: 21,
      returnMethod: 'https://schema.org/ReturnByMail',
      returnFees: 'https://schema.org/ReturnShippingFees',
    });
    expect(buildMerchantReturnPolicy(on).merchantReturnDays).toBe(RETURN_POLICY.defaultWindowDays);
  });

  it('is on every offer of a product, identical for every visitor', () => {
    const base = {
      name: 'N',
      sku: 'S',
      brand: 'B',
      images: ['https://s.example/a.jpg'],
      url: 'https://s.example/p',
      returnPolicy: buildMerchantReturnPolicy(RETURN_POLICY),
    };
    const one = buildProduct({
      ...base,
      offers: [{ price: money(100), availability: 'InStock', url: base.url }],
    });
    const many = buildProduct({
      ...base,
      offers: [
        { price: money(100), availability: 'InStock', url: base.url },
        { price: money(200), availability: 'OutOfStock', url: base.url },
      ],
    });
    const policy = buildMerchantReturnPolicy(RETURN_POLICY);
    expect(JSON.stringify(one)).toContain(JSON.stringify(policy));
    if ('offers' in many.offers) {
      expect(many.offers.hasMerchantReturnPolicy).toEqual(policy);
      expect(
        many.offers.offers.every(
          (offer) => JSON.stringify(offer.hasMerchantReturnPolicy) === JSON.stringify(policy),
        ),
      ).toBe(true);
    }
    expect(
      JSON.stringify(
        buildProduct({
          ...base,
          offers: [{ price: money(100), availability: 'InStock', url: base.url }],
        }),
      ),
    ).toBe(JSON.stringify(one));
  });
});

describe('the page summary, the form and the server agree with the JSON-LD', () => {
  for (const locale of ['uk', 'en'] as const) {
    it(`${locale}: the summary lists exactly the accepted reasons and, for the rest, says they are not accepted`, async () => {
      const html = await summary(locale, 14);
      expect(reasonsIn(html, 'accepted-reasons')).toEqual([...acceptedReturnReasons()]);
      const refused = reasonsIn(html, 'refused-reasons');
      expect([...reasonsIn(html, 'accepted-reasons'), ...refused].sort()).toEqual(
        [...returnReasonValues].sort(),
      );
      expect(refused.every((reason) => !isReasonAccepted(reason))).toBe(true);
      // The JSON-LD says "not permitted" exactly when the page lists refused reasons.
      expect(refused.length > 0).toBe(
        buildMerchantReturnPolicy(RETURN_POLICY).returnPolicyCategory ===
          'https://schema.org/MerchantReturnNotPermitted',
      );
    });

    it(`${locale}: the summary sentence carries the window days and cites Resolution 172 while returns are not voluntary`, async () => {
      const html = await summary(locale, 21);
      expect(html).toContain('21');
      expect(html).toMatch(/172/);
      const key = RETURN_POLICY.voluntaryReturns ? 'returnsPolicyVoluntary' : 'returnsPolicyStrict';
      const sentence = MESSAGES[locale].account[key].replace('{days}', '21');
      expect(html).toContain(sentence);
    });

    it(`${locale}: every reason the form can offer has a label, and the page does not promise "everything"`, () => {
      for (const reason of returnReasonValues) {
        expect(typeof MESSAGES[locale].account.reason[reason]).toBe('string');
      }
      const strict = MESSAGES[locale].account.returnsPolicyStrict;
      expect(strict).not.toMatch(/для всього|for everything|any reason|будь-якої причини/i);
    });
  }

  it('the form offers only the accepted reasons: it is built from the shared list and not from the enum', () => {
    const source = readFileSync(join(__dirname, '../components/account/return-form.tsx'), 'utf8');
    expect(source).toContain('acceptedReturnReasons()');
    expect(source).not.toContain('returnReasonValues');
  });

  it('the server check and the form use the same function (core imports isReasonAccepted from the shared policy)', () => {
    const source = readFileSync(
      join(__dirname, '../../../../packages/core/src/returns/customer.ts'),
      'utf8',
    );
    expect(source).toContain("from '@store/shared/return-policy'");
    expect(source).toContain('isReasonAccepted(input.reason)');
  });

  it('the product page builds its markup from the same constants', () => {
    const source = readFileSync(join(__dirname, '../app/[locale]/product/[slug]/page.tsx'), 'utf8');
    expect(source).toContain('buildMerchantReturnPolicy(RETURN_POLICY)');
  });
});
