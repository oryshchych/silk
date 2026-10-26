import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Пакети монорепо — TypeScript-джерела, їх компілює Next.
  transpilePackages: ['@store/shared'],
  images: {
    // `domains` у 16 немає. Хости R2 / CDN додаються разом із packages/media.
    remotePatterns: [],
    // Явно: за замовчуванням лише [75] (AGENTS.md §4).
    qualities: [75],
  },
};

export default withNextIntl(nextConfig);
