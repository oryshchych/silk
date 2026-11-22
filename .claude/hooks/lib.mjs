// Спільне для хуків Claude Code. Вхід — JSON на stdin; блокування — exit 2
// з поясненням у stderr (його бачить агент). exit 1 НЕ блокує: це «помилка
// хука», хід іде далі, і запобіжник виявляється фіктивним.
import { readFileSync } from 'node:fs';

/** Некоректний або порожній вхід → {}: хук не блокує те, чого не розуміє. */
export function readInput() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

export const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
