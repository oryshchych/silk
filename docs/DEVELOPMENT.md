# DEVELOPMENT.md

Девелоперський сетап. Усе з цього файлу входить у **фазу 0** — до першого
рядка доменного коду, не після.

Принцип: правило, яке не перевіряється автоматично, не існує. У `CLAUDE.md`
було написано «ніяких `any`», але жодне правило цього не забороняло — тобто
це було побажання, а не інваріант.

---

## 0. Версії — перевірено на вересень 2026

Перша редакція цього файлу містила застарілі версії з пам'яті (Node 22,
TS 5.x, PG 16). Виправлено.

| Компонент | Версія | Примітка |
|---|---|---|
| **Node.js** | **24 LTS** | Active LTS. 22 перейшов у Maintenance, 26 — Current (травень 2026) і для продакшену ще не бажаний. Пін через `.nvmrc` + `engines` + `engine-strict=true` |
| **TypeScript** | **6.0** | Не 7. Обґрунтування нижче |
| **PostgreSQL** | **18** | 18.6 стабільна, 19 у beta. Було 16 — два мажори тому |
| Next.js | 16.3 | |
| React | 19.2 | |
| pnpm | 10+ | postinstall-скрипти блоковані за замовчуванням |

### Чому TS 6, а не 7

TypeScript 7.0 вийшов у липні 2026 — нативний компілятор на Go, збірка у
8–12 разів швидша. Спокусливо, але для цього проєкту передчасно, і причина
конкретна: **у 7.0 немає стабільного програмного API** (обіцяють у 7.1).
Тому TS 7 не можуть використовувати typescript-eslint, Drizzle-парсер і
тулінг Vue, Svelte, Astro, MDX, Angular.

Наш енфорсмент «ніяких `any`» цілком тримається на type-aware лінтингу.
Поставити лише TS 7 — це не «лінт впаде», це **лінт замовкне**: ESLint не
видасть помилки, просто перестане застосовувати `no-unsafe-*`. Ви дізнаєтесь
про це через місяць, коли `any` вже розповзся.

Технічно можна поставити обидва під аліасами (`@typescript/native` для
`tsc`, `@typescript/typescript6` для API) — так робить Nx. Але це складність
зараз в обмін на секунди збірки, яких на магазині ви не помітите. `tsc` тут
не вузьке місце.

**Мігруєте на 7 після 7.1 зі стабільним API** — тоді це буде зміна однієї
версії, а не конструкція з аліасів.

### Дефолти, які варто знати заздалегідь

TS 7 приймає дефолти 6.0 і робить їх порушення хардовими помилками. Оскільки
ми на 6.0, це ще налаштування, а не примус — але вписуємо одразу так, щоб
майбутній перехід був безболісним:

- `strict: true` — у 6.0 вказуємо явно, у 7 стане дефолтом
- `types: []` — у 7 дефолт, тому глобальні типи перелічуємо явно **вже
  зараз** (`"types": ["node"]`). Інакше при апгрейді «раптово зникнуть
  типи Node», і це найчастіша причина здивування
- `stableTypeOrdering` — увімкнути в 6.0: у 7 воно дефолт і не
  конфігурується, тому будь-яка залежність від старого порядку типів
  краще виявиться зараз

### PostgreSQL 18 — три речі, які варто взяти

- **`uuidv7()`** — timestamp-ordered UUID. Наші PK на `defaultRandom()`
  (uuidv4) фрагментують B-tree на таблицях із високим темпом вставки:
  `orders`, `order_items`, `payment_events`, `product_views`, `outbox`.
  Для них перейти на uuidv7. Для довідників різниці немає.
- **Generated columns тепер VIRTUAL за замовчуванням.** Наш `search_norm`
  мусить бути **явно `STORED`**, інакше GIN-індекс по ньому не побудується.
  Раніше `STORED` було дефолтом, і цей рядок легко пропустити при апгрейді.
- **`OLD` і `NEW` у `RETURNING`** для `UPDATE`. Прямо корисно для
  умовного звільнення резерву: одним запитом отримуємо і попереднє, і нове
  значення, замість читання до й після.

Docker-образ Postgres усе одно свій (hunspell + ICU), тому мажор
контролюємо самі. Не «останній», а зафіксований 18 із явним планом
апгрейду.

---
## 1. TypeScript — суворість вище за `strict`

`strict: true` — це база, а не мета. Реальну безпеку дають прапорці, яких у
`strict` немає.

```jsonc
// tsconfig.base.json — TS 6.0, з прапорцями під майбутній перехід на 7
{
  "compilerOptions": {
    "strict": true,
    // У TS 7 дефолт []. Перелічуємо явно вже зараз, щоб апгрейд
    // не «загубив» типи Node
    "types": ["node"],
    // У TS 7 дефолт і не конфігурується — вмикаємо заздалегідь
    "stableTypeOrdering": true,

    // Найважливіший прапорець у цьому переліку.
    // arr[0] стає T | undefined, row.name — теж.
    // Без нього половина «типізованого» коду бреше:
    // items[i].price виглядає безпечним і падає в рантаймі.
    "noUncheckedIndexedAccess": true,

    // { a?: string } більше не приймає { a: undefined }.
    // Важливо для partial-апдейтів у Drizzle: інакше "очистити поле"
    // і "не чіпати поле" виглядають однаково.
    "exactOptionalPropertyTypes": true,

    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,

    // import type обов'язковий явно — прибирає сюрпризи зі side-effect
    // імпортами й циклічними залежностями
    "verbatimModuleSyntax": true,
    "isolatedModules": true,

    // Забороняє TS enum, namespace, parameter properties —
    // усе, що не стирається. Ми їх не використовуємо (pgEnum з Drizzle —
    // це функція, не TS enum), тому прапорець безкоштовний.
    "erasableSyntaxOnly": true,

    "skipLibCheck": true,
    "moduleDetection": "force",
    "target": "ES2024",
    "lib": ["ES2024"],
    "moduleResolution": "bundler"
  }
}
```

`noUncheckedIndexedAccess` дасть кількасот помилок на старті існуючого коду.
Тому він вмикається у фазі 0, коли коду немає.

---

## 2. ESLint — з перевіркою типів, інакше «ніяких any» недосяжне

Правила про `any` без type-aware лінтингу не працюють: `no-explicit-any`
ловить лише явне слово `any`, а не `any`, що приїхав із нетипізованої
бібліотеки. Тому `projectService: true`.

```js
// eslint.config.js (flat config; next lint у 16 не існує)
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Preset ОБОВ'ЯЗКОВИЙ: сам факт наявності projectService не вмикає
  // type-aware лінтинг. Без цього рядка правила no-unsafe-* тихо не
  // працюють, і ESLint при цьому не падає.
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ── Заборона any: п'ять правил, не одне ────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // ts-expect-error з описом ≥ 20 символів; ts-ignore заборонений
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': true,
        'ts-expect-error': { descriptionFormat: '^: .{20,}$' },
      }],

      // ── Асинхронність: для платежів це не стиль, а коректність ──
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      // Новий статус у enum → всі switch падають на білді.
      // Прямо потрібне для order_status і payment_status.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
    },
  },
);
```

`strict-boolean-expressions` — свідомо **не** вмикаю. З
`noUncheckedIndexedAccess` воно дає стільку шуму, що люди починають писати
`!!x` механічно, і сенс губиться.

### Правила, специфічні для цього проєкту

Ось де лінтер приносить найбільше, бо кодифікує ADR:

```js
// УВАГА: flat config НЕ мерджить опції одного правила між блоками —
// останній блок, що збігся, ПЕРЕЗАПИСУЄ попередній. Перша редакція цього
// файлу мала саме цю помилку: блок `packages/**` затирав заборони для
// `packages/core/**`, і головний запобіжник (глобальний db у домені)
// не працював.
//
// Тому області робимо НЕПЕРЕТИННИМИ, а спільні заборони дублюємо явно.
{
  files: ['packages/core/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['next', 'next/*'], message: 'packages/core не імпортує Next.js. Викликач робить revalidateTag, не домен.' },
        // Та сама помилка №1 зі списку пасток у CLAUDE.md
        { group: ['@store/db/client'], message: 'Приймай tx параметром. Глобальний db у домені = частковий коміт.' },
      ],
    }],
  },
},
{
  // Явно виключаємо core, щоб не затерти блок вище
  files: ['packages/**', 'apps/worker/**'],
  ignores: ['packages/core/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{ group: ['next/cache'], message: 'revalidateTag живе в apps/web. Воркер інвалідує через outbox (ADR-8).' }],
    }],
  },
},
{
  // process.env читається ЛИШЕ через валідований модуль (ADR-10)
  files: ['**/*.ts', '**/*.tsx'],
  // Виняток звужений до конкретного модуля, не будь-якого env.ts
  ignores: ['packages/shared/src/env.server.ts'],
  rules: {
    'no-restricted-properties': ['error', {
      object: 'process', property: 'env',
      message: 'Читай через @store/shared/env — він валідований zod і падає на старті.',
    }],
  },
},
{
  // Заборона hex у компонентах (ADR-21)
  files: ['apps/web/**/*.tsx'],
  rules: {
    'no-restricted-syntax': ['error', {
      selector: 'Literal[value=/#[0-9a-fA-F]{3,8}/]',
      message: 'Використовуй семантичний токен (--surface, --text-primary), не hex.',
    }],
  },
}
```

Плюс: `eslint-plugin-jsx-a11y` (у фазі 12 є критерій a11y — краще ловити
одразу), `eslint-plugin-drizzle` (ловить `delete`/`update` без `where` —
для нас це буквально знищення даних), `eslint-plugin-i18next` для заборони
хардкоджених рядків у JSX.

### Гроші як branded type

Лінтер не зловить `price * quantity` з переплутаними одиницями. Це ловить
система типів:

```ts
// packages/shared/money.ts
declare const brand: unique symbol;
export type Money = number & { readonly [brand]: 'Money' };  // копійки

export const money = (kopiyky: number): Money => {
  if (!Number.isInteger(kopiyky)) throw new Error('Money must be integer kopiyky');
  return kopiyky as Money;
};
export const add = (a: Money, b: Money): Money => (a + b) as Money;
export const multiply = (a: Money, q: number): Money => (a * q) as Money;
```

Тепер `Money` не змішується з `number`, і випадкове ділення без округлення
не компілюється. Це те, що робить ADR-1 інваріантом, а не побажанням.

---

## 3. Prettier

Не було зовсім. ESLint і Prettier не конфліктують, якщо форматування
повністю віддане Prettier (`eslint-config-prettier` вимикає стилістичні
правила ESLint).

```jsonc
// .prettierrc.json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100,
  "plugins": ["prettier-plugin-tailwindcss"]  // сортує класи Tailwind
}
```

Плюс `.editorconfig`, `.vscode/settings.json` (formatOnSave, ESLint fix on
save) і `.vscode/extensions.json` із рекомендаціями — щоб у редакторі не
довелося налаштовувати вручну.

---

## 4. Git-хуки — lefthook

Lefthook, а не husky: один бінарник, паралельне виконання, нормально працює
з монорепо.

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    format: { glob: '*.{ts,tsx,json,md,css}', run: 'prettier --write {staged_files}', stage_fixed: true }
    lint:   { glob: '*.{ts,tsx}', run: 'eslint --fix --max-warnings 0 {staged_files}', stage_fixed: true }
    # Секрети не мають потрапляти в історію: з git їх не видалити
    secrets: { run: 'gitleaks protect --staged --redact' }

pre-push:
  parallel: true
  commands:
    typecheck: { run: 'pnpm turbo typecheck' }
    unit:      { run: 'pnpm turbo test:unit --filter=...[origin/main]' }

commit-msg:
  commands:
    commitlint: { run: 'pnpm commitlint --edit {1}' }
```

Conventional commits через commitlint — не для семантичного версіонування
(ми не публікуємо пакети), а щоб історія читалася при розборі інциденту.

Інтеграційні тести й e2e у хуках **не** запускаються: pre-push мусить
залишатися швидким, інакше його починають обходити через `--no-verify`.

---

## 5. Тести

### Три рівні, різні виконавці

```ts
// vitest.config.ts — projects, не один конфіг
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['**/*.unit.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['**/*.int.test.ts'],
          globalSetup: './test/pg-container.ts',
          // Транзакції й локи не паралеляться через один pool
          poolOptions: { threads: { singleThread: false } },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
```

### Інтеграційні — на реальному Postgres, без винятків

Testcontainers піднімає **наш** образ (із hunspell і ICU), не офіційний
`postgres:16`. Інакше тести не перевіряють тригер `search_vector` і
українське сортування.

Швидка ізоляція через template-базу:

```ts
// один раз: контейнер + міграції у базу store_template
// на кожен тест-файл: CREATE DATABASE test_x TEMPLATE store_template
```

Це на порядок швидше за прогін міграцій для кожного файлу й дає повну
ізоляцію без транзакційних трюків, які ламають тестування самих транзакцій.

**Що заборонено в інтеграційних тестах:**

- Мокати БД. Сенс саме в реальній.
- Fake timers для перевірки протермінувань. `expires_at` рахує Postgres
  (ADR-17), тому тест зсуває `now()` через `SET` або пише минулу дату, а не
  підмінює час у Node.
- Один пул з'єднань для перевірки гонок. Конкурентність вимагає **окремих**
  з'єднань і бар'єрів синхронізації, інакше два «паралельні» запити просто
  виконаються послідовно й тест буде зеленим ні про що.

### Покриття — per-package, не загальне

```ts
thresholds: {
  'packages/core/src/pricing/**':   { lines: 95, branches: 90 },
  'packages/core/src/inventory/**': { lines: 95, branches: 90 },
  'packages/payments/**':           { lines: 90, branches: 85 },
  global:                           { lines: 60 },
}
```

Загальний відсоток по монорепо нічого не означає: 80% із покритою розміткою
й непокритим розподілом знижок гірше за 60% із навпаки.

---

## 6. CI

Джоби, які мусять бути required checks:

| Джоб | Що ловить |
|---|---|
| `format` | `prettier --check` |
| `lint` | ESLint `--max-warnings 0` |
| `typecheck` | TS по всіх пакетах |
| `test:unit` | домен |
| `test:integration` | Postgres у сервісі, реальні транзакції й локи |
| `migrate:fresh` | **порожня** БД + усі міграції. Ловить те, чого `drizzle-kit check` не ловить: невиконуваний SQL, тригери, складені FK, порядок extensions |
| `migrate:upgrade` | копія попередньої схеми + нові міграції |
| `migrate:safety` | `squawk` на дангерні DDL — `ALTER TABLE` з блокуванням на великій таблиці |
| `build` | `next build` (Turbopack, без кастомного webpack) |
| `test:e2e` | Playwright, happy path checkout |
| `secrets` | `gitleaks` + `grep` по `.next/static` на патерни ключів |
| `boundaries` | `dependency-cruiser`: `core` не залежить від Next, немає циклів |
| `knip` | невикористані залежності, експорти, файли |
| `size` | `size-limit` на клієнтський бандл |
| `lighthouse` | Lighthouse CI на PLP і PDP: Performance ≥ 85, SEO = 100 |
| `ai-sync` | дзеркала AI-конфігів синхронні (`AI_SETUP.md`) |

Обов'язково: `concurrency: cancel-in-progress`,
`pnpm install --frozen-lockfile`, Turborepo remote cache, `turbo --affected`
для тестів у PR і повний прогін на `main`.

---

## 7. Залежності

- **Renovate** із групуванням: patch dev-залежностей — автомердж після
  зелених тестів; major — окремий PR із changelog.
- **pnpm 10 блокує postinstall-скрипти за замовчуванням.** Дозволені
  перелічуються явно в `onlyBuiltDependencies` (нам потрібен `sharp`).
  Це найдешевший захист від supply-chain, тому список тримаємо коротким.
- `pnpm audit --audit-level high` у CI.
- `.npmrc`: `engine-strict=true`, і **ніколи** `shamefully-hoist` — воно
  знищує головну перевагу pnpm (див. `CLAUDE.md` §7).

---

## 8. Валідація env — падати на старті

```ts
// packages/shared/env.ts — єдине місце, де читається process.env
const schema = z.object({
  APP_ENV: z.enum(['local', 'staging', 'production']),
  DATABASE_URL: z.string().url(),
  MONO_PLATA_TOKEN: z.string().min(1),
  EMAIL_TO_OVERRIDE: z.string().email().optional(),
  // ...
}).superRefine((v, ctx) => {
  // Не дати staging тихо розсилати листи реальним клієнтам
  if (v.APP_ENV !== 'production' && !v.EMAIL_TO_OVERRIDE) {
    ctx.addIssue({ code: 'custom', message: 'EMAIL_TO_OVERRIDE обов\'язковий поза production' });
  }
});

export const env = schema.parse(process.env);
```

Це те, що робить `ENVIRONMENTS.md` виконуваним, а не документацією. І
причина, чому `no-restricted-properties` на `process.env` стоїть у лінтері.

---

## 9. Скрипти

```jsonc
{
  "dev": "turbo dev",
  "build": "turbo build",
  "typecheck": "turbo typecheck",
  "lint": "eslint . --max-warnings 0",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "test": "vitest run --project unit",
  "test:int": "vitest run --project integration",
  "test:e2e": "playwright test",
  "db:migrate": "drizzle-kit migrate",
  "db:seed": "tsx packages/db/seed/index.ts",
  "db:studio": "drizzle-kit studio",
  "verify": "turbo typecheck lint test && pnpm format:check",
  "ai:sync": "tsx scripts/sync-ai-config.ts",
  "ai:check": "tsx scripts/sync-ai-config.ts --check"
}
```

`pnpm verify` — одна команда перед комітом. Вона ж у `CLAUDE.md` як
definition of done.
