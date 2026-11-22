/**
 * Тести хуків Claude Code (.claude/hooks). Запобіжник без тесту — побажання:
 * регулярка, що пропускає `psql ... prod-db` або блокує `select * from
 * products`, ламається тихо. Хуки запускаються як справжні процеси з тим
 * самим JSON на stdin, який дає Claude Code.
 *
 * post-edit-verify і stop-typecheck тут не перевіряються: вони запускають
 * prettier, eslint і typecheck (секунди), перевірені вручну в PR.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

interface HookResult {
  status: number | null;
  stderr: string;
}

function runHook(hook: string, input: unknown): HookResult {
  const result = spawnSync('node', [join(root, '.claude/hooks', hook)], {
    cwd: root,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

const bash = (command: string): { tool_input: { command: string } } => ({
  tool_input: { command },
});
const edit = (filePath: string): { tool_input: { file_path: string } } => ({
  tool_input: { file_path: filePath },
});

describe('guard-production: блокує', () => {
  it.each([
    'cat .env.production',
    'head -3 ./.env.production',
    'source .env.production',
    '. ./.env.production',
    'docker compose --env-file .env.production up',
    'DATABASE_URL=postgres://u:p@prod-db.example.com/store pnpm db:migrate',
    'psql -h prod-db -U x store',
    'psql postgres://u@db.production.internal/store -c "drop table orders"',
    'pg_dump -h production.db store',
    'APP_ENV=production pnpm db:seed',
    'pnpm exec drizzle-kit push',
    'drizzle-kit push --force',
    'git push --force origin main',
    'git push -f',
    'git push origin +main',
    'git push --force-with-lease',
    'docker compose -f docker-compose.yml -f docker-compose.production.yml up -d',
    'curl https://api.monobank.ua/api/merchant/invoice/create -d {}',
    'curl -X POST https://secure.wayforpay.com/pay',
    // Обгортки навколо команди.
    'FOO=1 psql -h prod-db store',
    'sudo psql -h production.internal store',
    'cat dump.sql | psql -h prod-db store',
    'cd packages/db && git push --force',
    'pnpm --filter @store/db exec drizzle-kit push',
    'npx drizzle-kit push',
    'export DATABASE_URL=postgres://u:p@prod-db/store',
    'DATABASE_MIGRATE_URL=postgres://u:p@db.production.internal/store pnpm db:migrate',
    'curl https://api.novaposhta.ua/v2.0/json/ -d \'{"modelName":"InternetDocument","calledMethod":"save"}\'',
  ])('%s', (command) => {
    const result = runHook('guard-production.mjs', bash(command));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/guard-production/);
  });
});

describe('guard-production: пропускає (хибні спрацювання)', () => {
  it.each([
    'psql -c "select count(*) from products"',
    'psql -d store -c "select * from product_variants"',
    'git commit -m "docs: the agent never reads .env.production"',
    'git push origin feat/x',
    'git push -u origin docs/state',
    'cat docs/ENVIRONMENTS.md',
    'grep -n production docker-compose.production.yml',
    'docker compose -f docker-compose.yml -f docker-compose.production.yml config',
    'docker compose -f docker-compose.production.yml ps',
    'APP_ENV=production node server.js',
    'DATABASE_URL=postgres://store_app:x@localhost:54322/store pnpm db:seed',
    'pnpm db:migrate',
    'curl http://localhost:3000/api/health',
    'curl -s https://staging.damazla.com/robots.txt',
    'ls -la .env.example',
    'pnpm verify',
    // Проза: документація, коміт-меседжі й echo не є командами.
    'python3 - <<PY\nprint("`psql` / `pg_dump` до prod, `drizzle-kit push`, `git push --force`")\nPY',
    'git commit -m "feat: guard blocks cat .env.production and psql prod"',
    'echo "drizzle-kit push is forbidden, git push --force too"',
    'git commit -m "docs: no curl https://api.monobank.ua from the agent"',
    'cat <<EOF > notes.md\nNever run: psql -h prod-db\nEOF',
  ])('%s', (command) => {
    expect(runHook('guard-production.mjs', bash(command)).status).toBe(0);
  });

  it('не блокує на сміттєвому вході', () => {
    expect(runHook('guard-production.mjs', 'не json').status).toBe(0);
    expect(runHook('guard-production.mjs', {}).status).toBe(0);
  });
});

describe('block-applied-migration', () => {
  it.each([
    ['закомічена міграція', join(root, 'packages/db/migrations/0001_schema.sql')],
    ['відносний шлях', 'packages/db/migrations/0002_numbering.sql'],
    ['закомічений снапшот', join(root, 'packages/db/migrations/meta/0001_snapshot.json')],
    ['журнал drizzle', join(root, 'packages/db/migrations/meta/_journal.json')],
    ['обхід через ..', join(root, 'packages/db/migrations/../migrations/0001_schema.sql')],
  ])('блокує: %s', (_, filePath) => {
    const result = runHook('block-applied-migration.mjs', edit(filePath));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/нову міграцію|НОВУ міграцію/i);
  });

  it.each([
    [
      'нова (незакомічена) міграція',
      join(root, 'packages/db/migrations/9999_not_yet_committed.sql'),
    ],
    ['schema.ts', join(root, 'packages/db/src/schema.ts')],
    ['файл поза міграціями', join(root, 'README.md')],
  ])('пропускає: %s', (_, filePath) => {
    expect(runHook('block-applied-migration.mjs', edit(filePath)).status).toBe(0);
  });

  it('не блокує на сміттєвому вході', () => {
    expect(runHook('block-applied-migration.mjs', 'не json').status).toBe(0);
    expect(runHook('block-applied-migration.mjs', {}).status).toBe(0);
  });
});
