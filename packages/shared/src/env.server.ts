/**
 * ЄДИНЕ місце в репозиторії, де читається process.env.
 * Виняток у ESLint звужений саме до цього файла (ADR-10).
 *
 * Парсинг відбувається при імпорті: помилка конфігурації мусить падати на
 * старті процесу, а не в момент першої відправки листа.
 */
import { parseEnv } from './env.schema';
import type { Env } from './env.schema';

export const env: Env = parseEnv(process.env);

export type { Env, AppEnv } from './env.schema';
export { appEnvValues } from './env.schema';
