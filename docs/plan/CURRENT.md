# CURRENT.md — стан роботи

> Пам'ять між сесіями. Стан живе тут і в git, а не в контексті.
> **Агент оновлює цей файл останньою дією кожної сесії.**

## Поточна фаза

`phase-00-foundation.md` — інфраструктура зроблена; БД, застосунки,
Testcontainers, AI-сетап і деплой не розпочаті.

## Зроблено

- `6728094` монорепо pnpm + Turborepo, пінування (Node 24, TS 6.0.3, PG 18)
- `4a343fe` type-aware ESLint, Prettier, dependency-cruiser, knip
- `56a06b3` `packages/shared/src/env.{schema,server}.ts` — zod, 12 тестів
- `94f0a8d` lefthook, commitlint, Renovate
- `8cf15f9` три стеки compose + власний образ Postgres 18 (hunspell + ICU)
- `b659006` CI: format, lint, typecheck, test-unit, boundaries, knip, secrets,
  audit, db-image
- `cd35956` керований блок AGENTS.md (`@next/codemod agents-md`, 16.3.4)
- `3d48a11` pnpm 12: `allowBuilds` замість `onlyBuiltDependencies`

## Наступний крок

Сесія 2: схема БД і міграції. `packages/db/src/schema.ts` уже в репо (1962
рядки) і типізується чисто — не чіпали. Потрібні: `0000_extensions.sql`
вручну (згенерована → `0001`, див. REVIEW_TRIAGE), клієнт БД, seed, далі
`migrate:fresh` / `migrate:upgrade` / `migrate:safety` в CI. Міграції
запускати роллю `store_migrate` — default privileges видані саме їй.

## Критерії, перевірені виконанням

- `pnpm verify` зелений **на чистому клоні** (format + lint + typecheck 2
  пакети + 12 unit)
- `noUncheckedIndexedAccess` і `exactOptionalPropertyTypes` увімкнені; під ними
  компілюється й `schema.ts`
- падають на лінті: `any`, `as any`, `@ts-ignore`, короткий `@ts-expect-error`,
  `next/*` у `packages/core`, глобальний `db`, `process.env` поза
  `env.server.ts`, hex у `.tsx` (перевірено пробним файлом)
- процес падає на старті без `EMAIL_TO_OVERRIDE` поза production
- `pnpm dev:db` з чистого клону піднімає Postgres + Mailpit
- образ БД: сортування `г ґ е є и і ї`, hunspell (`мереживні` →
  `мереживний`), стоп-слова, store_app не робить DDL
- коміт із секретом блокується gitleaks; pre-push жене typecheck + unit
- `docker compose config` валідний для local / staging / production

Решта критеріїв фази 0 — наступні сесії: `db:migrate`/`db:seed`,
Testcontainers, `migrate:fresh`, `/` vs `/en`, токени Tailwind, `ai:check`,
деплой, basic auth + noindex, бекапи в R2.

## Відкриті рішення, що чекають людину

- Бухгалтер: сертифікати на нашій системі оподаткування; чи потрібен ПРРО
- Підтвердження доступу до українського API Нової Пошти 2.0
- Назва магазину замість `LACE & SILK`
- Docker Desktop не бачить `~/Documents` (bind mount падає). Стек це вже не
  використовує; для інших mount-ів додати шлях у Settings → File sharing

## Відхилення від плану

- TS **6.0.3**, не «6.0 + 7.0 через аліаси» з REVIEW_TRIAGE: `DEVELOPMENT.md` §0
  цей варіант уже відкинув. Renovate тримає `< 7`
- Postgres на **Debian**, не Alpine: в Alpine немає `hunspell-uk`
- том монтується на `/var/lib/postgresql` (у 18+ дані в підкаталозі мажора)
- `allowBuilds` замість `onlyBuiltDependencies` (перейменовано в pnpm 12)
- init-скрипти Postgres вбудовані в образ, не монтуються
- `typescript-eslint` 8.69.0: 8.70.0 не проходить `minimumReleaseAge`
- `Money` і DTO-шар не робились — це доменний код
- Prettier не форматує `docs/`, `CLAUDE.md`, `AGENTS.md`, `packages/db/`
- плагіни jsx-a11y / drizzle / i18next / prettier-tailwind — разом із кодом,
  який вони перевіряють
