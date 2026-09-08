import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.schema';

/** Мінімум без EMAIL_TO_OVERRIDE — щоб перевірити саме його відсутність. */
const withoutOverride = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgres://store:store@localhost:54322/store',
} as const;

const base = { ...withoutOverride, EMAIL_TO_OVERRIDE: 'dev@example.com' } as const;

const productionSecrets = {
  AUTH_SECRET: 'x',
  MONO_PLATA_TOKEN: 'x',
  WAYFORPAY_MERCHANT_ACCOUNT: 'x',
  WAYFORPAY_SECRET_KEY: 'x',
  NOVA_POSHTA_API_KEY: 'x',
  RESEND_API_KEY: 'x',
  R2_ACCOUNT_ID: 'x',
  R2_ACCESS_KEY_ID: 'x',
  R2_SECRET_ACCESS_KEY: 'x',
  R2_BUCKET_MEDIA: 'media',
} as const;

describe('parseEnv', () => {
  it('приймає коректне local-середовище', () => {
    const env = parseEnv(base);
    expect(env.APP_ENV).toBe('local');
    expect(env.NODE_ENV).toBe('development');
  });

  it('падає поза production без EMAIL_TO_OVERRIDE', () => {
    expect(() => parseEnv(withoutOverride)).toThrow(/EMAIL_TO_OVERRIDE/);
  });

  it('падає на staging без EMAIL_TO_OVERRIDE', () => {
    expect(() => parseEnv({ ...withoutOverride, APP_ENV: 'staging' })).toThrow(/EMAIL_TO_OVERRIDE/);
  });

  it('не вимагає EMAIL_TO_OVERRIDE у production', () => {
    const env = parseEnv({ ...withoutOverride, APP_ENV: 'production', ...productionSecrets });
    expect(env.EMAIL_TO_OVERRIDE).toBeUndefined();
  });

  it('падає у production без секретів платіжки', () => {
    expect(() => parseEnv({ ...withoutOverride, APP_ENV: 'production' })).toThrow(
      /MONO_PLATA_TOKEN/,
    );
  });

  it('вимагає basic auth на staging', () => {
    expect(() =>
      parseEnv({ ...base, APP_ENV: 'staging', EMAIL_TO_OVERRIDE: 'dev@example.com' }),
    ).toThrow(/STAGING_BASIC_AUTH_USER/);
  });

  it('відкидає невідомий APP_ENV', () => {
    expect(() => parseEnv({ ...base, APP_ENV: 'dev' })).toThrow(/APP_ENV/);
  });

  it('відкидає DATABASE_URL з чужим протоколом', () => {
    // new URL() вважає 'localhost:5432' валідним URL, тому перевіряється
    // саме протокол, а не «схожість на URL».
    expect(() => parseEnv({ ...base, DATABASE_URL: 'localhost:5432' })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...base, DATABASE_URL: 'https://localhost:5432/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('не показує значень у повідомленні про помилку', () => {
    try {
      parseEnv({
        ...withoutOverride,
        APP_ENV: 'production',
        MONO_PLATA_TOKEN: 'super-secret-token',
      });
      expect.unreachable('parseEnv мусив кинути помилку');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-token');
    }
  });
});
