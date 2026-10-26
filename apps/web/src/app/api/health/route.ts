/**
 * Liveness для healthcheck контейнера (docker-compose.yml) і Dokploy.
 * Лише «процес живий і відповідає»: без запитів до БД, щоб збій Postgres
 * не перезапускав web по колу. Готовність БД перевіряється окремо.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
