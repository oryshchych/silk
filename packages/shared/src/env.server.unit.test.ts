import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Перевіряється саме падіння НА СТАРТІ, а не поведінка схеми: імпорт
 * модуля мусить кинути помилку, бо парсинг відбувається при завантаженні.
 */
describe('env.server', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://store:store@localhost:54322/store');
    vi.stubEnv('EMAIL_TO_OVERRIDE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('падає при імпорті, якщо APP_ENV != production і немає EMAIL_TO_OVERRIDE', async () => {
    vi.stubEnv('APP_ENV', 'staging');

    await expect(import('./env.server')).rejects.toThrow(/EMAIL_TO_OVERRIDE/);
  });

  it('падає при імпорті, якщо APP_ENV не заданий', async () => {
    vi.stubEnv('APP_ENV', undefined);

    await expect(import('./env.server')).rejects.toThrow(/APP_ENV/);
  });

  it('імпортується, коли середовище коректне', async () => {
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('EMAIL_TO_OVERRIDE', 'dev@example.com');

    const mod = await import('./env.server');

    expect(mod.env.APP_ENV).toBe('local');
  });
});
