import { describe, expect, it } from 'vitest';

import {
  isAuthorized,
  parseExcludeList,
  requiresAuth,
  type StagingGateConfig,
} from './staging-gate';

const config: StagingGateConfig = {
  user: 'team',
  password: 's3cret:with:colons',
  webhookPaths: ['/api/webhooks/mono', '/api/webhooks/wayforpay'],
};

const basic = (credentials: string): string =>
  `Basic ${Buffer.from(credentials).toString('base64')}`;

describe('isAuthorized', () => {
  it('приймає правильні облікові дані (пароль може містити двокрапки)', () => {
    expect(isAuthorized(basic('team:s3cret:with:colons'), config)).toBe(true);
  });

  it.each([
    ['без заголовка', null],
    ['інша схема', 'Bearer abc'],
    ['неправильний пароль', basic('team:wrong')],
    ['неправильний користувач', basic('admin:s3cret:with:colons')],
    ['без двокрапки', basic('team')],
    ['порожні', basic(':')],
  ])('відмовляє: %s', (_, header) => {
    expect(isAuthorized(header, config)).toBe(false);
  });
});

describe('requiresAuth', () => {
  it('сторінки й API закриті', () => {
    expect(requiresAuth('GET', '/', config)).toBe(true);
    expect(requiresAuth('GET', '/en', config)).toBe(true);
    expect(requiresAuth('GET', '/api/orders', config)).toBe(true);
  });

  it('вебхук відкритий лише для POST і лише точним шляхом', () => {
    expect(requiresAuth('POST', '/api/webhooks/mono', config)).toBe(false);
    expect(requiresAuth('GET', '/api/webhooks/mono', config)).toBe(true);
    expect(requiresAuth('POST', '/api/webhooks/mono/extra', config)).toBe(true);
    expect(requiresAuth('POST', '/api/webhooks', config)).toBe(true);
  });

  it('liveness відкритий для healthcheck', () => {
    expect(requiresAuth('GET', '/api/health', config)).toBe(false);
  });
});

describe('parseExcludeList', () => {
  it('розбирає список із .env, відкидаючи сміття', () => {
    expect(parseExcludeList(' /api/webhooks/mono, /api/webhooks/wayforpay ,,api/x')).toEqual([
      '/api/webhooks/mono',
      '/api/webhooks/wayforpay',
    ]);
    expect(parseExcludeList(undefined)).toEqual([]);
  });
});
