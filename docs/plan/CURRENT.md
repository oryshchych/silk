# CURRENT.md — стан роботи

> Пам'ять між сесіями. Стан живе тут і в git, а не в контексті.
> **Агент оновлює цей файл останньою дією кожної сесії.**

## Поточна фаза

`phase-00-foundation.md` — звіт віддано 2026-11-22: **23 з 24 критеріїв**
виконано. Відкритий лише №20 («`pg_dump` у R2 по cron»): перший нічний
запуск о 03:00 (Київ) 2026-11-23. Фазу 0.5 **не починати** без явного
«переходь до фази 0.5». Staging: `https://staging.damazla.com` (basic auth);
Hetzner CAX11 (ARM, 4 ГБ, 49.12.64.197), Dokploy `https://dokploy.damazla.com`.

## Зроблено

- `6728094`…`3d48a11` монорепо, тулінг, env, compose, образ PG 18, CI
- PR #1–#2 міграції + Testcontainers, відповіді бухгалтера (ПРРО, шви)
- PR #3 `createDb()`/`Tx`, seed; #4–#6 `Money`, DTO, `apps/web`, `ai/`, скіли
- PR #8–#9 образ web, `migrate`, закритий staging; #10–#11 `pg_dump` у R2
- PR #12 хуки `.claude/` (`a6db51c`)

## Наступний крок

Після 03:00 (Київ) 2026-11-23: у `staging/` бакета R2 має бути другий файл
(`rclone lsl`, контейнер `dump`) — закриває критерій №20. Далі за командою
фаза 0.5, але спершу рішення людини нижче.

## Критерії, перевірені виконанням (2026-11-22, чистий клон `a6db51c`)

- `pnpm verify` 124 тести; `pnpm dev` → `/` uk, `/en` en; `db:migrate` +
  `db:seed` на порожній БД нашого образу: 6 міграцій, 40 товарів, 15 замовлень
- `pnpm test:int` 30/30 (`search_vector`, ICU `г ґ е є и і ї`, нумерація, FK)
- лінт ловить `any`, `ts-ignore`, короткий `ts-expect-error`, `next/*` у
  `core`, `process.env`, hex у `.tsx` (пробні файли); gitleaks блокує коміт
- один образ `c18a1bb315cf`: local → robots Disallow, staging → 401 без
  пароля, production → Allow; без `EMAIL_TO_OVERRIDE` exit 1
- staging: 401 + `noindex`, HTTPS, автодеплой через 2 с після кожного з
  3 мерджів; бекап → відновлення, лічильники збігаються; розклад
  симульовано (запуск рівно о `BACKUP_AT`); `ai:check`, CI main — 13 джобів

## Відкриті рішення, що чекають людину

- Назва магазину (`LACE & SILK` — заглушка), брендова палітра й шрифти
- API НП 2.0; акаунт Checkbox; COD: друк чека в коробку; чек повернення
  лише на `sale` (NOTES.md)
- З обсягу фази 0, не зроблено: CI `test:integration`, `migrate:upgrade`,
  `migrate:safety`, `size-limit`; Playwright, shadcn/ui, jsx-a11y (ESLint 10)

## Відхилення від плану

- TS 6.0.3; Postgres на Debian; Next 16.4.3 (у ≤ 16.4.0 критичні RCE)
- Tailwind v4: токени в CSS `@theme`, не в `tailwind.config.ts`
- basic auth staging — у застосунку (`proxy.ts`); `worker` прибрано з compose
  до 0.5; rclone 1.76.0 (Debian-1.60 несумісний з R2); хуки — Node, без `allow`
- на GitHub лишились влиті гілки `docs/accountant-answers`, `feat/db-migrations`,
  `feat/db-client-seed`, `feat/money-dto` — видалити в UI
