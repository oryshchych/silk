// ESLint flat config. `next lint` у Next 16 не існує — ESLint CLI напряму.
//
// УВАГА (REVIEW_TRIAGE, раунд 3): flat config НЕ мерджить опції одного
// правила між блоками — останній блок, що збігся, ПЕРЕЗАПИСУЄ попередній.
// Тому області для `no-restricted-imports` зроблені НЕПЕРЕТИННИМИ через
// `ignores`, а спільні заборони дублюються явно.
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '.next-docs/**',
      // Схема БД і міграції — окрема сесія фази 0. Тут не чіпаємо.
      'packages/db/**',
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
