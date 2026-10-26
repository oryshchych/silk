/**
 * Одне джерело правил для всіх AI-інструментів (docs/AI_SETUP.md §1–2).
 *
 *   ai/canonical.md        — ЄДИНЕ місце, яке редагується руками
 *   ai/claude-specific.md  — лише Claude Code
 *
 * Генерує AGENTS.md, CLAUDE.md, .github/copilot-instructions.md і
 * .cursor/rules/project.mdc. Керований блок `@next/codemod agents-md`
 * (між маркерами NEXT-AGENTS-MD-*) береться з поточного AGENTS.md як є:
 * його оновлює codemod, не ми.
 *
 *   pnpm ai:sync   — перегенерувати
 *   pnpm ai:check  — CI: впасти, якщо згенероване розійшлося з джерелом
 *
 * Запускається Node напряму (type stripping), тому без відносних імпортів.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const START = '<!-- NEXT-AGENTS-MD-START -->';
const END = '<!-- NEXT-AGENTS-MD-END -->';

function managedNextBlock(): string {
  const agents = read('AGENTS.md');
  const start = agents.indexOf(START);
  const end = agents.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(
      'У AGENTS.md немає керованого блоку Next. Відновити: npx @next/codemod agents-md --output AGENTS.md',
    );
  }
  return agents.slice(start, end + END.length);
}

const banner = (source: string): string =>
  `<!-- ЗГЕНЕРОВАНО з ${source}. Не редагувати. -->\n` +
  `<!-- Правки: ${source} → pnpm ai:sync (перевіряє CI: pnpm ai:check). -->\n`;

function render(): Map<string, string> {
  const canonical = read('ai/canonical.md').trim();
  const claude = read('ai/claude-specific.md').trim();
  const next = managedNextBlock();
  const body = `${canonical}\n\n${next}\n`;

  return new Map([
    ['AGENTS.md', `# AGENTS.md\n\n${banner('ai/canonical.md')}\n${body}`],
    ['CLAUDE.md', `# CLAUDE.md\n\n${banner('ai/claude-specific.md')}\n@AGENTS.md\n\n${claude}\n`],
    [
      '.github/copilot-instructions.md',
      `# Інструкції проєкту\n\n${banner('ai/canonical.md')}\n${body}`,
    ],
    [
      '.cursor/rules/project.mdc',
      `---\ndescription: Канонічні правила проєкту (AGENTS.md)\nalwaysApply: true\n---\n\n` +
        `${banner('ai/canonical.md')}\n${body}`,
    ],
  ]);
}

const check = process.argv.includes('--check');
const stale: string[] = [];

for (const [path, content] of render()) {
  const full = join(root, path);
  const current = existsSync(full) ? readFileSync(full, 'utf8') : undefined;
  if (current === content) continue;
  if (check) {
    stale.push(path);
    continue;
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  console.log(`оновлено ${path}`);
}

if (stale.length > 0) {
  console.error(
    `AI-конфіги розійшлися з ai/: ${stale.join(', ')}\n` +
      'Правити треба ai/canonical.md або ai/claude-specific.md, потім pnpm ai:sync.',
  );
  process.exit(1);
}
if (check) console.log('AI-конфіги синхронні з ai/.');
