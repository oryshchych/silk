// PreToolUse(Bash): агент не торкається production — ні секретів, ні БД, ні
// реальних платежів чи ТТН (AGENTS.md §6). Список свідомо грубий: хибне
// блокування дешевше за реальний платіж або DDL на проді.
//
// Правила застосовуються до ПЕРШОГО СЛОВА простої команди, а не до будь-якого
// згадування рядка: heredoc із документацією, коміт-меседж чи `echo` із
// текстом «psql … prod» чи «git push --force» не блокуються. Команда
// ділиться на прості по переведенню рядка, `;`, `&&`, `||`, `|`, `&`.
//
// Відомий пропуск: обгортки на кшталт `ssh host 'psql … prod'` або
// `bash -c "…"` не розбираються. Це запобіжник від помилки агента, а не
// пісочниця — ізоляція секретів описана в docs/AI_SETUP.md.
import { block, readInput } from './lib.mjs';

const command = readInput().tool_input?.command;
if (typeof command !== 'string') process.exit(0);

// «prod» / «production» як окреме слово: «products» НЕ збігається.
const PROD = /(?<![a-z])prod(?:uction)?(?![a-z])/i;
const ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const PREFIX = /^(?:(?:sudo|time|nohup|command|exec|env)\s+)+/;
const PG_CLIENTS = /^(?:psql|pg_dump|pg_restore|pg_dumpall)\b/;
const READERS =
  /^(?:cat|less|more|head|tail|grep|egrep|sed|awk|cp|mv|source|\.|bat|xxd|od|strings|open|code|vim?|nano|scp|rsync|base64)\s/;
const DRIZZLE_PUSH =
  /^(?:(?:pnpm|npx|yarn|bunx|exec|dlx|run)\s+|--filter\s+\S+\s+|-C\s+\S+\s+)*drizzle-kit\s+push\b/;
const HTTP_CLIENTS = /^(?:curl|wget|http|https|xh)\b/;

/** [assigns, rest] — змінні на початку команди окремо від самої команди. */
function split(segment) {
  const trimmed = segment.trim();
  const assigns = ASSIGN.exec(trimmed)?.[0] ?? '';
  const rest = trimmed.slice(assigns.length).replace(PREFIX, '');
  return [assigns, rest];
}

/** Повертає опис порушення або null. */
function violation(segment) {
  const [assigns, rest] = split(segment);

  if (READERS.test(rest) && /\.env\.production\b/.test(rest)) {
    return 'читання продакшн-секретів (.env.production)';
  }
  if (/--env-file[=\s]+\S*\.env\.production\b/.test(rest)) return 'запуск із .env.production';
  if (/\bDATABASE(?:_MIGRATE)?_URL=\S*/.test(assigns) && PROD.test(assigns)) {
    return 'підключення до продакшн-БД (DATABASE_URL)';
  }
  if (/^export\s+DATABASE(?:_MIGRATE)?_URL=\S*/.test(rest) && PROD.test(rest)) {
    return 'підключення до продакшн-БД (DATABASE_URL)';
  }
  if (PG_CLIENTS.test(rest) && PROD.test(rest)) return 'клієнт Postgres до продакшн-БД';
  if (
    /\bAPP_ENV=production\b/.test(assigns) &&
    /\b(?:db:migrate|db:seed|migrate|seed|drizzle-kit)\b/.test(rest)
  ) {
    return 'міграції/seed з APP_ENV=production';
  }
  if (DRIZZLE_PUSH.test(rest)) return 'drizzle-kit push (змінює схему без файла міграції)';
  if (
    /^git\s+push\b/.test(rest) &&
    (/\s--force(?:-with-lease)?(?:\s|=|$)/.test(rest) ||
      /\s-f(?:\s|$)/.test(rest) ||
      /\s\+[^\s:]+/.test(rest))
  ) {
    return 'git push --force';
  }
  if (
    /^docker[- ]compose\b/.test(rest) &&
    /docker-compose\.production\.yml/.test(rest) &&
    !/\s(?:config|ps|logs)(?:\s|$)/.test(rest)
  ) {
    return 'операції з продакшн-стеком (дозволені лише config / ps / logs)';
  }
  if (HTTP_CLIENTS.test(rest) && /(?:api\.monobank\.ua|wayforpay\.com)/i.test(rest)) {
    return 'прямий запит до платіжного провайдера';
  }
  if (HTTP_CLIENTS.test(rest) && /novaposhta\.ua/i.test(rest) && /InternetDocument/.test(rest)) {
    return 'створення ТТН Нової Пошти';
  }
  return null;
}

for (const segment of command.split(/\n|;|&&|\|\||\||&/)) {
  const what = violation(segment);
  if (what !== null) {
    block(
      `Заблоковано guard-production: ${what}.\n` +
        'Це дія лише з явного дозволу людини (AGENTS.md §6) — попроси виконати вручну.',
    );
  }
}
