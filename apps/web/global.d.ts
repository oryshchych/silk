import type uk from './messages/uk.json';

declare global {
  /** Ключі перекладів типізовані з uk.json: відсутній ключ — помилка компіляції. */
  type IntlMessages = typeof uk;

  namespace NodeJS {
    interface ProcessEnv {
      /** Константа збірки Next: у якому runtime виконується код. */
      readonly NEXT_RUNTIME?: 'nodejs' | 'edge';
    }
  }
}

declare module 'next-intl' {
  interface AppConfig {
    Locale: 'uk' | 'en';
    Messages: typeof uk;
  }
}
