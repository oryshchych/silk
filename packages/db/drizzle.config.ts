import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit використовується для `generate` і `check` (без з'єднання з
 * БД). Застосування міграцій — `src/migrate.ts`, роллю store_migrate:
 * default privileges для store_app видані саме їй (infra/postgres/init).
 *
 * `push` заборонений (CLAUDE.md): він змінює схему без файла міграції.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
