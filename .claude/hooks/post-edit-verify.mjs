// PostToolUse(Edit|Write|MultiEdit): prettier + eslint --fix одразу після
// правки, щоб агент не накопичував файли, які разом не пройдуть CI.
// Помилки, які --fix не виправив, повертаються агенту (exit 2).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

import { block, projectDir, readInput } from './lib.mjs';

const filePath = readInput().tool_input?.file_path;
if (typeof filePath !== 'string') process.exit(0);

const abs = resolve(projectDir, filePath);
const rel = relative(projectDir, abs);
if (!existsSync(abs) || rel.startsWith('..') || rel.includes('node_modules')) process.exit(0);

const run = (cmd, args) => spawnSync(cmd, args, { cwd: projectDir, encoding: 'utf8' });
const pnpmExec = (...args) => run('pnpm', ['exec', ...args]);

// .prettierignore поважається; невідомі типи файлів пропускаються.
pnpmExec('prettier', '--write', '--ignore-unknown', '--log-level', 'warn', rel);

if (['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(rel))) {
  // Type-aware лінт вебзастосунку потребує згенерованих типів маршрутів
  // (PageProps, LayoutProps, next/root-params): на свіжому checkout їх немає.
  if (rel.startsWith('apps/web/') && !existsSync(join(projectDir, 'apps/web/next-env.d.ts'))) {
    run('pnpm', ['--filter', 'web', 'typegen']);
  }
  const lint = pnpmExec('eslint', '--fix', '--no-warn-ignored', '--max-warnings', '0', rel);
  if (lint.status !== 0) {
    block(`eslint після правки ${rel}:\n${(lint.stdout + lint.stderr).trim()}`);
  }
}
