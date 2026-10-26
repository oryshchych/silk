import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // projects, не один конфіг: рівні тестів мають різних виконавців.
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.unit.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.int.test.ts'],
          // Транзакції й локи не паралеляться через один pool.
          testTimeout: 30_000,
          // Testcontainers із НАШИМ образом Postgres (hunspell + ICU) і
          // прогоном усіх міграцій на порожню БД — тобто migrate:fresh.
          globalSetup: './packages/db/test/pg-container.ts',
          // Збірка образу при першому прогоні + старт контейнера.
          hookTimeout: 600_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      // Порогові покриття per-package, не загальне: загальний відсоток по
      // монорепо нічого не означає.
      thresholds: {
        'packages/core/src/pricing/**': { lines: 95, branches: 90 },
        'packages/core/src/inventory/**': { lines: 95, branches: 90 },
        'packages/payments/**': { lines: 90, branches: 85 },
        global: { lines: 60 },
      },
    },
  },
});
