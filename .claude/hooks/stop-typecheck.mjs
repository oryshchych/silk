// Stop: не завершувати хід із червоним typecheck. Через exit 2 — звичайний
// exit 1 хід НЕ блокує, і запобіжник був би фіктивним (CLAUDE.md).
//
// Запускається лише коли є незакомічені зміни (інакше нічого не змінилось).
// Повторний Stop після блокування (stop_hook_active) пропускається — без
// цього хід зациклився б, якщо агент не може виправити помилку сам.
import { spawnSync } from 'node:child_process';

import { block, projectDir, readInput } from './lib.mjs';

if (readInput().stop_hook_active === true) process.exit(0);

const status = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
if (status.status !== 0 || status.stdout.trim() === '') process.exit(0);

const typecheck = spawnSync('pnpm', ['typecheck'], { cwd: projectDir, encoding: 'utf8' });
if (typecheck.status !== 0) {
  const tail = (typecheck.stdout + typecheck.stderr).trim().split('\n').slice(-40).join('\n');
  block(`typecheck червоний — виправ перед завершенням ходу:\n${tail}`);
}
