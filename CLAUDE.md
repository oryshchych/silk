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

## Хуки — спроєктовані, ще НЕ підключені

`.claude/settings.json` і `.claude/hooks/` змінюють дозволи й запускають код
автоматично, тому вмикає їх людина, не агент. До того ці запобіжники —
лише текст:

- `PreToolUse` на `Edit|Write` → блокує правку **вже закоміченої** міграції
  або її снапшота — тільки нова міграція
- `PreToolUse` на `Bash` → блокує `.env.production`, `psql`/DDL на
  production, `drizzle-kit push`, `git push --force`, прямі запити до
  платіжок і створення ТТН, `APP_ENV=production`
- `PostToolUse` на `Edit|Write` → prettier + eslint --fix одразу; залишкові
  помилки лінту повертаються агенту (exit 2)
- `Stop` → typecheck, якщо є незакомічені зміни. **Через wrapper з exit
  code 2** — звичайний exit 1 хід не блокує, і запобіжник був би фіктивним

## Permissions

`deny`: `git push --force`, `psql *production*`, `drizzle-kit push`,
`Read(./.env*)`.

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
