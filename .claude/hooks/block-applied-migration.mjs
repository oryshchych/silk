// PreToolUse(Edit|Write|MultiEdit): застосовану міграцію не правимо — лише
// нова. «Застосована» = уже закомічена в git: її могли прогнати на staging чи
// production, і правка розвела б журнал drizzle і реальну схему назавжди.
// Нова (ще не закомічена) міграція, зокрема створена `generate --custom`,
// редагується вільно. Те саме для снапшотів і журналу в migrations/meta.
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

import { block, projectDir, readInput } from './lib.mjs';

const filePath = readInput().tool_input?.file_path;
if (typeof filePath !== 'string') process.exit(0);

const rel = relative(projectDir, resolve(projectDir, filePath));
if (!rel.startsWith('packages/db/migrations/')) process.exit(0);

let tracked = false;
try {
  execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], {
    cwd: projectDir,
    stdio: 'ignore',
  });
  tracked = true;
} catch {
  tracked = false;
}

if (tracked) {
  block(
    `Заблоковано: ${rel} уже закомічений — застосовані міграції не змінюються.\n` +
      'Створи НОВУ міграцію (скіл /new-migration): `pnpm db:generate` або\n' +
      '`pnpm --filter @store/db exec drizzle-kit generate --custom --name=<що>`.\n' +
      'Журнал і снапшоти змінює лише drizzle-kit, не ручна правка.',
  );
}
