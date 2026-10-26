/**
 * Валідація середовища на СТАРТІ сервера, а не при першому запиті (ADR-10):
 * імпорт `@store/shared/env` парсить process.env і кидає, якщо конфігурація
 * некоректна — наприклад, немає EMAIL_TO_OVERRIDE поза production.
 *
 * Next сам лише логує помилку хука й далі відповідає 500 на кожен запит.
 * Процес мусить ЗАВЕРШИТИСЬ: тоді оркестратор бачить падіння, healthcheck
 * не проходить і трафік не перемикається на зламаний контейнер.
 */
try {
  await import('@store/shared/env');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
