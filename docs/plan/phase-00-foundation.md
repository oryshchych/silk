## Фаза 0 — Фундамент (3–4 дні)

**Мета:** середовище, у якому код доїжджає до продакшену передбачувано.

**Обсяг:**
- Монорепо: pnpm workspaces + Turborepo. Структура за `ARCHITECTURE.md` §2.
- `packages/db`: Drizzle schema, міграції, seed.
- Postgres 16 у Docker, розширення `pg_trgm`, `unaccent`, `btree_gin`.
- `apps/web`: **Next.js 16.3**, App Router, TS strict, Tailwind, shadcn/ui.
  - Node 22 LTS у Dockerfile (мінімум для 16 — 20.9; Node 18 не підтримується).
  - Turbopack дефолтний, прапорців не треба. Кастомний webpack не додавати — з ним `next build` впаде.
  - `next lint` не існує — ESLint CLI, flat config.
  - `proxy.ts` замість `middleware.ts`, named export `proxy`.
  - `next typegen`, хелпери `PageProps<'/catalog/[...slug]'>`.
  - **`npx @next/codemod@canary agents-md`** — генерує `AGENTS.md` з посиланням на документацію, версійно збігану зі встановленим Next.js. Зробити до першого рядка коду.
- Дизайн-токени в `tailwind.config.ts` — до першого компонента, не після.
  **Семантичні назви, не літеральні** (ADR-21): `--surface`,
  `--surface-raised`, `--text-primary`, `--text-muted`, `--border`,
  `--accent`, а не `--blush` / `--cream`. Це те, що робить майбутню темну
  тему днем роботи замість правок у 40 компонентах.
  `color-scheme: light` на `:root`, щоб браузер не інвертував нативні
  контроли самостійно.
- i18n-роутинг: `/` = UK, `/en/*` = EN, `next-intl`.
- `docker-compose.yml`: local, staging, production як три окремі стеки (`ENVIRONMENTS.md`).
- **Auth-схема повністю** (ADR-19): `auth_users`, `auth_credentials`, `auth_totp`,
  `auth_recovery_codes`, `auth_sessions`. JWT із `sid` + серверний реєстр
  відкликання. **Bearer-токени проєктуються тут**, бо мобільний застосунок
  підтверджений як реалістичний (питання №4) — прикручувати їх потім означає
  переносити активні сесії на іншу модель.
- **Модель фінансових операцій:** `payment_attempts`, `refund_operations`,
  `fiscal_documents`, `outbox`, `webhook_quarantine`. Без реалізації
  провайдерів, але зі схемою й типами — фінансовий контракт мусить існувати
  до платіжної інтеграції, а не після.
- **DTO-шар** у `packages/shared` із zod-схемами входу й виходу. Обов'язково
  з першого дня: це те, що робить майбутній `/api/v1` дешевим і не дає
  повернути клієнту повний Drizzle-об'єкт.
- **Seed-генератор моків** (питання №5): створює **реальні рядки в БД**, не
  фікстури, тому все редагується звичайною адмінкою. ~40 товарів із
  варіантами й залишками, 3 сертифікати, 5 промокодів різних типів,
  15 замовлень у всіх статусах включно з поверненнями, 10 відгуків,
  категорії з SEO-текстами. Запускається на local і staging, **ніколи** на
  production (перевірка по `APP_ENV`).
- **Тулінг цілком за `DEVELOPMENT.md`** — до першого рядка доменного коду:
  - TS: `strict` **плюс** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
    `verbatimModuleSyntax`, `erasableSyntaxOnly`. Перший з них дасть сотні
    помилок на наявному коді, тому вмикається зараз, коли коду немає.
  - ESLint flat config із **type-aware** лінтингом (`projectService: true`) —
    без нього «ніяких `any`» недосяжне: `no-explicit-any` ловить лише явне
    слово, а не `any` з нетипізованої бібліотеки. Тому п'ять правил:
    `no-explicit-any` + `no-unsafe-{assignment,member-access,call,return,argument}`.
  - Правила, що кодифікують ADR: `no-restricted-imports` на `next/*` у
    `packages/core`, на глобальний `db` у домені, на `next/cache` у воркері;
    `no-restricted-properties` на `process.env`; заборона hex у компонентах.
  - `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check` —
    для застосунку з платежами це коректність, не стиль.
  - Prettier + `eslint-config-prettier` + `.editorconfig` + `.vscode/`.
  - `Money` як branded type — щоб ADR-1 був інваріантом системи типів, а не
    побажанням у документі.
  - lefthook: pre-commit (prettier, eslint --fix, gitleaks), pre-push
    (typecheck + affected unit), commit-msg (commitlint).
  - Renovate, `pnpm audit`, `onlyBuiltDependencies` лише для `sharp`.
  - Валідація env через zod у `packages/shared/env.ts` — падає на старті,
    якщо `APP_ENV != production` і немає `EMAIL_TO_OVERRIDE`.
- **Тестова інфраструктура:** Vitest projects (unit / integration),
  Testcontainers із **нашим** образом Postgres (hunspell + ICU, не офіційним),
  ізоляція через `CREATE DATABASE ... TEMPLATE`, Playwright, порогові
  покриття per-package (`pricing` і `inventory` — 95%).
- **AI-сетап цілком за `AI_SETUP.md`:** канонічний `AGENTS.md`,
  `CLAUDE.md` лише з Claude-специфічним, генеровані дзеркала для Copilot і
  Cursor із перевіркою синхронності в CI, `.claude/skills` (`new-migration`,
  `money-change`, `new-webhook`, `phase-report`), `.claude/agents`
  (`money-reviewer`, `migration-reviewer`, `security-auditor`, `seo-reviewer`),
  хуки на блокування правки застосованих міграцій і на захист продакшену.
- CI (required checks): `format`, `lint`, `typecheck`, `test:unit`,
  `test:integration`, **`migrate:fresh`** (порожня БД + усі міграції —
  ловить те, чого `drizzle-kit check` не ловить), `migrate:upgrade`,
  `migrate:safety` (squawk), `build`, `secrets` (gitleaks + grep по
  `.next/static`), `boundaries` (dependency-cruiser), `knip`, `size-limit`,
  `ai-sync`.
- Deploy: Dokploy на Hetzner, домен, Cloudflare, SSL.
- Staging закритий basic auth + `X-Robots-Tag: noindex` + `robots.txt` Disallow.

**Критерії приймання:**
- [ ] `pnpm dev` піднімає застосунок + БД однією командою з чистого клону
- [ ] `pnpm db:migrate && pnpm db:seed` проходять без помилок
- [ ] `pnpm verify` проходить (typecheck + lint --max-warnings 0 + unit + format:check)
- [ ] `noUncheckedIndexedAccess` увімкнений і код під ним компілюється
- [ ] Спроба написати `any` або `as any` падає на лінті, не на рев'ю
- [ ] `ts-ignore` заборонений; `ts-expect-error` вимагає опису ≥ 20 символів
- [ ] Імпорт `next/*` у `packages/core` падає на лінті з осмисленим повідомленням
- [ ] `process.env` поза `packages/shared/env.ts` падає на лінті
- [ ] Застосунок **падає на старті**, якщо `APP_ENV != production` без `EMAIL_TO_OVERRIDE`
- [ ] Інтеграційний тест піднімає Testcontainers із **нашим** образом Postgres
      і перевіряє тригер `search_vector` та українське сортування
- [ ] `migrate:fresh` у CI: порожня БД + усі міграції, включно з ручними
- [ ] Один канонічний `AGENTS.md`; `pnpm ai:check` підтверджує синхронність дзеркал
- [ ] Хук блокує правку вже застосованої міграції
- [ ] `git commit` із секретом у diff блокується gitleaks
- [ ] `git push` у `main` деплоїть на staging по HTTPS
- [ ] `/` та `/en` віддають різний текст
- [ ] `AGENTS.md` існує й вказує на `node_modules/next/dist/docs/`
- [ ] Один Docker-образ з різними `.env` читає різні значення (перевірка ADR-10)
- [ ] Staging недоступний без basic auth і віддає `X-Robots-Tag: noindex`
- [ ] `pg_dump` у R2 виконався по cron, файл на місці
- [ ] `grep -r "from 'next" packages/core/` порожній
- [ ] Палітра й шрифти живуть у `tailwind.config.ts`; у компонентах немає hex-кодів
- [ ] Токени названі семантично (`--surface`, `--text-primary`), не за
      кольором (`--blush`). Перевірка: `grep -rE "blush|cream|pink" packages/ apps/web/components/` порожній
- [ ] `color-scheme: light` встановлено; нативні селекти й скролбари не інвертуються

---
