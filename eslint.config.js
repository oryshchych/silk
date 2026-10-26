// ESLint flat config. `next lint` у Next 16 не існує — ESLint CLI напряму.
//
// УВАГА (REVIEW_TRIAGE, раунд 3): flat config НЕ мерджить опції одного
// правила між блоками — останній блок, що збігся, ПЕРЕЗАПИСУЄ попередній.
// Тому області для `no-restricted-imports` зроблені НЕПЕРЕТИННИМИ через
// `ignores`, а спільні заборони дублюються явно.
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import i18next from 'eslint-plugin-i18next';
import prettierConfig from 'eslint-config-prettier';

import money from './eslint-rules/money.js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '.next-docs/**',
      '**/next-env.d.ts',
      // schema.ts — канонічний файл зі своїми `(): any` у self-reference FK
      // (обмеження Drizzle). Не чіпаємо його в цій фазі; решта packages/db
      // (раннер міграцій, тести) лінтиться як звичайний код.
      'packages/db/src/schema.ts',
      'packages/db/migrations/**',
    ],
  },

  // Preset ОБОВ'ЯЗКОВИЙ: сам факт наявності projectService не вмикає
  // type-aware лінтинг. Без цього рядка правила no-unsafe-* тихо не
  // працюють, і ESLint при цьому не падає.
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ── Заборона any: п'ять правил, не одне ─────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // ts-expect-error з описом >= 20 символів; ts-ignore заборонений
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': { descriptionFormat: '^: .{20,}$' },
        },
      ],

      // ── Асинхронність: для платежів це коректність, не стиль ────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      // Новий статус у enum -> всі switch падають на білді.
      // Прямо потрібне для order_status і payment_status.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // DoD (AGENTS.md §3): немає console.log і закоментованого коду.
      'no-console': 'error',

      // strict-boolean-expressions свідомо НЕ вмикається: з
      // noUncheckedIndexedAccess воно дає стільку шуму, що люди
      // починають писати !!x механічно, і сенс губиться.
    },
  },

  // ADR-1: арифметика над Money — лише через функції money.ts. Сам
  // money.ts виключений: там операції обгорнуті конструктором із перевіркою.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/shared/src/money.ts'],
    plugins: { money },
    rules: { 'money/no-arithmetic': 'error' },
  },

  // DTO — allowlist полів (AGENTS.md §4b.3). Схема, що пропускає невідомі
  // ключі, перетворює DTO на повний Drizzle-об'єкт.
  {
    files: ['packages/shared/src/dto/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(passthrough|catchall|loose|looseObject)$/]',
          message:
            'DTO мусить відкидати невідомі ключі: лише z.object без passthrough / catchall / loose.',
        },
      ],
    },
  },

  // Скрипти й воркер — легітимні місця для виводу в stdout.
  {
    files: ['scripts/**', 'apps/worker/**'],
    rules: { 'no-console': 'off' },
  },

  // ── ADR у вигляді правил ──────────────────────────────────────────
  // Область 1: домен. Не імпортує ні Next.js, ні глобальний db.
  {
    files: ['packages/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message:
                'packages/core не імпортує Next.js. Викликач робить revalidateTag, не домен (AGENTS.md §2.3).',
            },
            {
              group: ['@store/db/client'],
              message:
                'Приймай tx параметром. Глобальний db у домені = частковий коміт (AGENTS.md §4b.1).',
            },
          ],
        },
      ],
    },
  },
  // Область 2: решта пакетів і воркер. core виключений явно, щоб не
  // затерти блок вище.
  {
    files: ['packages/**', 'apps/worker/**'],
    ignores: ['packages/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next/cache'],
              message: 'revalidateTag живе в apps/web. Воркер інвалідує через outbox (ADR-8).',
            },
          ],
        },
      ],
    },
  },

  // process.env читається ЛИШЕ через валідований модуль (ADR-10).
  // Виняток звужений до конкретного файла, не будь-якого env.ts.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/shared/src/env.server.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Читай через @store/shared/env — він валідований zod і падає на старті (ADR-10).',
        },
      ],
    },
  },

  // Next.js: правила core-web-vitals (next/image, next/link, шрифти).
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs['core-web-vitals'].rules,
      // Правило для pages/ — у нас лише App Router.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Жодних хардкоджених рядків у JSX: усе через next-intl, ключі в uk і en
  // (AGENTS.md §3). Атрибути на кшталт className / href — не текст.
  {
    files: ['apps/web/**/*.tsx'],
    plugins: { i18next },
    rules: { 'i18next/no-literal-string': ['error', { mode: 'jsx-only' }] },
  },

  // Заборона hex у компонентах (ADR-21).
  {
    files: ['apps/web/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}/]',
          message: 'Використовуй семантичний токен (--surface, --text-primary), не hex.',
        },
      ],
    },
  },

  // Конфіги в .js/.mjs/.cjs поза TS-проєктом: type-aware правила там
  // застосувати неможливо, тому вимикаємо їх явно, а не «випадково».
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-console': 'off',
    },
  },

  // Останнім: вимикає стилістичні правила ESLint на користь Prettier.
  prettierConfig,
);
