# CURRENT.md — стан роботи

> Пам'ять між сесіями. Стан живе тут і в git, а не в контексті.
> **Агент оновлює цей файл останньою дією кожної сесії.**

## Поточна фаза

`phase-00-foundation.md` — усі кроки зроблено; лишається звіт фази 0
(`/phase-report`) і явне «переходь до фази 0.5». Staging:
`https://staging.damazla.com` (basic auth). Сервер Hetzner CAX11 (ARM, 4 ГБ,
Ubuntu 24.04, 49.12.64.197), Dokploy — `https://dokploy.damazla.com`.

## Зроблено

- `6728094`…`3d48a11` монорепо, тулінг, env, compose, образ PG 18, CI
- PR #1–#2 міграції + Testcontainers, відповіді бухгалтера (ПРРО, шви)
- PR #3 `createDb()`/`Tx`, seed, БД з шаблону; PR #4–#6 `Money`, DTO,
  `apps/web` (Next 16.4.3, next-intl, Tailwind v4), `ai/` + скіли й агенти
- PR #8–#9 образ web, сервіс `migrate`, закритий staging; PR #10–#11
  щоденний `pg_dump` у R2 (rclone 1.76.0)
- хуки `.claude/` (`feat/claude-hooks`)

## Наступний крок

Звіт фази 0, потім за командою — фаза 0.5. Завтра перевірити, що о 03:00
(Київ) у `staging/` бакета R2 з'явився другий бекап. Далі `migrate:upgrade`.

## Критерії, перевірені виконанням

- `pnpm migrate:fresh` 17/17 на порожній БД нашого образу; негативні
  контролі (без 0000, без `STORED`, без `GRANT CREATE`) падають; `db:check`
- seed: 40 товарів, 15 замовлень, звірки резервів і сум — 0 розбіжностей;
  повтор і production відмовляють; `test:int` 30/30
- staging: 401 без пароля, 200 з паролем, `noindex` + `robots.txt`
  Disallow, `/api/health` 200, HTTPS Let's Encrypt, 6 міграцій, ICU
  `г ґ е є и і ї`; без паролів суперкористувача в контейнері web
- автодеплой: лог деплою стартував через 2 с після мерджу в `main`
- бекап: `backup-now` на staging — 225 951 Б, 53 таблиці; відновлення в
  тимчасову БД — лічильники збігаються
- хуки: 59 unit-тестів; наживо заблокували правку закоміченої міграції й
  мою ж команду; eslint-помилки повернулись агенту; Stop-typecheck exit 2
- `ai:check`, `verify`, knip, boundaries, audit (high 0) — зелені

## Відкриті рішення, що чекають людину

- API НП 2.0; назва магазину (`LACE & SILK`); акаунт Checkbox
- COD: друк паперового чека в коробку; чек повернення лише на `sale` (NOTES.md)

## Відхилення від плану

- TS 6.0.3; Postgres на Debian; Next 16.4.3 (у ≤ 16.4.0 критичні RCE)
- store_migrate має `CREATE ON DATABASE`; міграції — `drizzle-orm` migrator
- Tailwind v4: токени в CSS `@theme`; `allocate` у `shared/money`
- basic auth staging — у застосунку (`proxy.ts`), не в Caddy/Dokploy
- web отримує явний перелік змінних, не `env_file`; `worker` прибрано з
  compose до фази 0.5
- rclone 1.76.0 з офіційного образу: Debian-1.60 несумісний з R2 (501)
- хуки — Node (`.mjs`), `allow`-список у settings не додано
- `allowBuilds`: заборонені postinstall перелічені явно
