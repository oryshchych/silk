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
| `/review-pr-silk` | **every PR**: gates, specialist reviewers, project best-practice checklist; fix and re-run until PASS |

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
- `PreToolUse` on `Bash` → `guard-merge`: `gh pr merge` goes through it. It
  refuses unless the PR is open, targets `main`, is not a draft, is mergeable,
  every CI job from `ci.yml` succeeded, and the latest `review-pr-silk` report
  (by the authenticated user, header on the first line, 12+ hex sha) is a PASS
  for the current head commit; the command must pin it with
  `--match-head-commit <full sha>`. It also refuses `--admin`, `--auto`, merges
  through `gh api`, `bash -c` and the like, and any `git push` to `main`. It
  fails closed (`scripts/merge-gate.ts`)
- `Stop` → `stop-typecheck`: `pnpm typecheck`, якщо є незакомічені зміни.
  **Через exit code 2** — звичайний exit 1 хід не блокує. Повторний Stop
  (`stop_hook_active`) пропускається, щоб не зациклитись

Хук змінює дію, а не дозвіл: він не замінює ізоляцію (див. нижче).

## Permissions

`deny` in `.claude/settings.json`: forced `git push`, `psql *production*`,
`drizzle-kit push`, and `Read` of `.env`, `.env.local`, `.env.staging` and
`.env.production` (`.env.example` stays readable).

`allow` has exactly one entry, `Bash(gh pr merge *)`, and it is only usable
together with the `guard-merge` hook (autonomous mode,
`docs/AUTONOMOUS_MODE.md`). `Bash(pnpm *)` stays off the list: it would allow
running arbitrary project code without a prompt.

`drizzle-kit push` is denied on purpose: it changes the schema without a
migration file, so it "works" locally and never reaches production.

**A limit to know:** `Read` and `Edit` denials do not control arbitrary Node
processes that open files themselves, and `Bash(pnpm *)` would run project
code. So production secrets must not exist on the filesystem or in the
environment where the agent runs. That is an isolation question, not a
permission-list question. Details: `docs/AI_SETUP.md`.

## MCP

Заплановано: Postgres **read-only** до local/staging (щоб дивитися фактичну
схему, а не припущення), Playwright (перевіряти свою роботу в браузері),
Context7 (актуальна документація Next 16 / Drizzle / Auth.js).

Ще **не підключено**: для read-only Postgres потрібна окрема роль лише з
`SELECT` — `store_app` має DML і для MCP не годиться.

Продакшн-БД до MCP не підключається. Ніколи.
