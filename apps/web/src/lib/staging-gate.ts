/**
 * Закритий staging (ENVIRONMENTS.md, пастки 0–1): basic auth на ВСЬОМУ,
 * крім точних POST-маршрутів вебхуків і liveness-перевірки.
 *
 * Чиста функція без Next: вхід — метод, шлях, заголовок Authorization і
 * конфіг; вихід — пропустити чи вимагати пароль. Тестується окремо.
 */
import { timingSafeEqual } from 'node:crypto';

export interface StagingGateConfig {
  user: string;
  password: string;
  /** Точні шляхи вебхуків (STAGING_BASIC_AUTH_EXCLUDE), лише для POST. */
  webhookPaths: readonly string[];
}

/** Docker healthcheck ходить без пароля; відповідь не розкриває нічого. */
const ALWAYS_OPEN = new Set(['/api/health']);

export function parseExcludeList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('/'));
}

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Різна довжина — все одно порівнюємо з собою, щоб час не залежав від неї.
  return left.length === right.length ? timingSafeEqual(left, right) : !timingSafeEqual(left, left);
};

export function isAuthorized(header: string | null, config: StagingGateConfig): boolean {
  if (header === null || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;
  const userOk = safeEqual(decoded.slice(0, separator), config.user);
  const passwordOk = safeEqual(decoded.slice(separator + 1), config.password);
  return userOk && passwordOk;
}

export function requiresAuth(method: string, pathname: string, config: StagingGateConfig): boolean {
  if (ALWAYS_OPEN.has(pathname)) return false;
  // ТОЧНИЙ збіг і лише POST: префікс /api відкрив би все API.
  if (method === 'POST' && config.webhookPaths.includes(pathname)) return false;
  return true;
}
