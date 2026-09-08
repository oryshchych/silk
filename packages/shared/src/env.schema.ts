/**
 * Схема середовища. Чиста: не читає process.env — цим займається
 * env.server.ts, і лише він (ADR-10, лінт-правило no-restricted-properties).
 *
 * Розділення на два файли не косметичне: схему треба тестувати з довільним
 * входом, а модуль, який парсить process.env, падає вже при імпорті.
 */
import { z } from 'zod';

export const appEnvValues = ['local', 'staging', 'production'] as const;

/**
 * СЕРВЕРНА змінна, без NEXT_PUBLIC_. NEXT_PUBLIC_ вшивається під час build,
 * тому один образ на двох середовищах вважав би себе production і обійшов
 * захист staging (ADR-10, ENVIRONMENTS.md, пастка 2).
 */
export const appEnvSchema = z.enum(appEnvValues);
export type AppEnv = z.infer<typeof appEnvSchema>;

/** Секрети, обов'язкові в production і опційні поза ним. */
const secretsRequiredInProduction = [
  'AUTH_SECRET',
  'MONO_PLATA_TOKEN',
  'WAYFORPAY_MERCHANT_ACCOUNT',
  'WAYFORPAY_SECRET_KEY',
  'NOVA_POSHTA_API_KEY',
  'RESEND_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_MEDIA',
] as const;

const secret = z.string().min(1).optional();

export const envSchema = z
  .object({
    APP_ENV: appEnvSchema,
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // z.url() сам по собі приймає 'localhost:5432' (для new URL це валідний
    // URL зі схемою 'localhost:'), тому схема протоколу задається явно —
    // інакше друкарська помилка в DSN проходить валідацію й падає вже
    // на першому запиті.
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    // Перекриває ВСІХ отримувачів поза production. Без нього застосунок
    // не стартує — інакше staging тихо розсилає листи реальним клієнтам
    // (ENVIRONMENTS.md, пастка 2).
    EMAIL_TO_OVERRIDE: z.email().optional(),
    EMAIL_FROM: z.email().optional(),

    AUTH_SECRET: secret,

    MONO_PLATA_TOKEN: secret,
    WAYFORPAY_MERCHANT_ACCOUNT: secret,
    WAYFORPAY_SECRET_KEY: secret,

    NOVA_POSHTA_API_KEY: secret,
    UKRPOSHTA_API_KEY: secret,

    RESEND_API_KEY: secret,

    R2_ACCOUNT_ID: secret,
    R2_ACCESS_KEY_ID: secret,
    R2_SECRET_ACCESS_KEY: secret,
    R2_BUCKET_MEDIA: secret,

    SENTRY_DSN: z.url({ protocol: /^https$/ }).optional(),

    // Build-time (REVIEW_TRIAGE): значення вшивається в бандл, тому воно
    // не може відрізнятися між staging і production на одному образі.
    NEXT_PUBLIC_SITE_URL: z.url({ protocol: /^https?$/ }).optional(),

    STAGING_BASIC_AUTH_USER: z.string().optional(),
    STAGING_BASIC_AUTH_PASSWORD: z.string().optional(),
    // Точні POST-маршрути вебхуків, які виключені з basic auth. Не префікс
    // /api: інакше провайдер отримує 401 і навіть не доходить до перевірки
    // підпису (ENVIRONMENTS.md, пастка 0).
    STAGING_BASIC_AUTH_EXCLUDE: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.APP_ENV !== 'production' && value.EMAIL_TO_OVERRIDE === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_TO_OVERRIDE'],
        message:
          "EMAIL_TO_OVERRIDE обов'язковий поза production: без нього стенд " +
          'розсилає листи реальним клієнтам.',
      });
    }

    if (value.APP_ENV === 'production') {
      for (const key of secretsRequiredInProduction) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} обов'язковий у production.`,
          });
        }
      }
    }

    if (value.APP_ENV === 'staging') {
      const hasUser = (value.STAGING_BASIC_AUTH_USER ?? '') !== '';
      const hasPassword = (value.STAGING_BASIC_AUTH_PASSWORD ?? '') !== '';
      if (!hasUser || !hasPassword) {
        ctx.addIssue({
          code: 'custom',
          path: ['STAGING_BASIC_AUTH_USER'],
          message:
            'STAGING_BASIC_AUTH_USER і STAGING_BASIC_AUTH_PASSWORD ' +
            "обов'язкові на staging: відкритий стенд потрапляє в індекс.",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Читабельне повідомлення без значень: у логи не потрапляє жоден секрет. */
export const formatEnvIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');

export const parseEnv = (raw: unknown): Env => {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Некоректне середовище:\n${formatEnvIssues(result.error)}`);
  }
  return result.data;
};
