# CLAUDE.md

<!-- ЗГЕНЕРОВАНО з ai/claude-specific.md. Не редагувати. -->
<!-- Правки: ai/claude-specific.md → pnpm ai:sync (перевіряє CI: pnpm ai:check). -->

@AGENTS.md

Канонічні правила — в `AGENTS.md`. Тут лише Claude-специфічне.

**`AGENTS.md`, `CLAUDE.md` і дзеркала для Copilot / Cursor генеруються.**
Правити `ai/canonical.md` або `ai/claude-specific.md`, потім `pnpm ai:sync`.
CI (`ai-sync`) падає, якщо згенероване розійшлося з джерелом.

## Скіли

| Скіл | Коли |
|---|---|
| `/new-migration` | будь-яка зміна схеми. Генерує, перевіряє squawk'ом, прогонює на порожній БД **і** на копії попередньої схеми, потім показує diff |
| `/money-change` | зміни в `pricing`, `inventory`, `orders`, `payments`. Чек-лист перед завершенням |
| `/new-webhook` | порядок операцій із ADR-4 покроково + обов'язкові тести |
| `/phase-report` | звіт за формою з `AGENTS.md` §1. Не переходить до наступної фази |

## Субагенти

| Агент | Коли |
|---|---|
| `money-reviewer` | перед комітом у `pricing` / `inventory` / `orders` / `payments` |
| `migration-reviewer` | кожна нова міграція |
| `security-auditor` | завершення фаз 4, 5, 12. Перевіряє **фактичну серіалізовану відповідь** для кожної ролі, не UI |
| `seo-reviewer` | фази 1 і 6 |

## Хуки (`.claude/hooks/*.mjs`, підключені в `.claude/settings.json`)

Детерміністичні запобіжники: правило в `AGENTS.md` агент може пропустити,
хук з exit code 2 блокує дію. Покриті тестами `scripts/hooks.unit.test.ts`.

- `PreToolUse` на `Edit|Write|MultiEdit` → `block-applied-migration`: блокує
  правку **вже закоміченої** міграції, її снапшота чи журналу — лише нова
  міграція (скіл `/new-migration`). Нова, ще не закомічена, редагується
- `PreToolUse` на `Bash` → `guard-production`: блокує читання
  `.env.production`, клієнти Postgres до prod, `DATABASE_URL` на prod,
  `drizzle-kit push`, примусовий `git push`, `docker compose` з
  production-файлом (крім `config` / `ps` / `logs`), прямі запити до платіжок
  і створення ТТН. Правила діють на **першу команду** кожного простого
  виразу, а не на згадування рядка: коміт-меседж чи документація з такими
  словами не блокуються. Обгортки на кшталт `ssh host '…'` не розбираються
- `PostToolUse` на `Edit|Write|MultiEdit` → `post-edit-verify`: prettier +
  eslint --fix одразу; помилки, які `--fix` не виправив, повертаються агенту
- `Stop` → `stop-typecheck`: `pnpm typecheck`, якщо є незакомічені зміни.
  **Через exit code 2** — звичайний exit 1 хід не блокує. Повторний Stop
  (`stop_hook_active`) пропускається, щоб не зациклитись

Хук змінює дію, а не дозвіл: він не замінює ізоляцію (див. нижче).

## Permissions

`deny` у `.claude/settings.json`: примусовий `git push`, `psql *production*`,
`drizzle-kit push`, `Read` для `.env`, `.env.local`, `.env.staging`,
`.env.production` (`.env.example` читається). Список `allow` **не додано**:
`Bash(pnpm *)` дозволив би запуск довільного коду проєкту без запиту.

`drizzle-kit push` заборонений свідомо: він змінює схему без файлу міграції,
тобто локально «працює», а в продакшн нічого не доїжджає.

**Обмеження, яке треба знати:** заборони `Read`/`Edit` не контролюють
довільні Node-процеси, які самі відкривають файли, а дозвіл `Bash(pnpm *)`
дає запуск коду проєкту. Тому продакшн-секретів не повинно бути у
файловій системі та env середовища, де працює агент. Це питання ізоляції,
а не списку дозволів. Деталі — `docs/AI_SETUP.md`.

## MCP

Заплановано: Postgres **read-only** до local/staging (щоб дивитися фактичну
схему, а не припущення), Playwright (перевіряти свою роботу в браузері),
Context7 (актуальна документація Next 16 / Drizzle / Auth.js).

Ще **не підключено**: для read-only Postgres потрібна окрема роль лише з
`SELECT` — `store_app` має DML і для MCP не годиться.

Продакшн-БД до MCP не підключається. Ніколи.
