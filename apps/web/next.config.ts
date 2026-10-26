import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Next читає .env лише з apps/web; у монорепо він лежить у корені
// (`cp .env.example .env`). Змінні, задані середовищем, не перезаписуються,
// тому в контейнері staging / production файл не потрібен і не впливає.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Docker-образ: .next/standalone з мінімальним server.js і лише
  // потрібними файлами node_modules (apps/web/Dockerfile).
  output: 'standalone',
  // Трасування від кореня монорепо, інакше пакети workspace
  // (@store/shared) не потраплять у standalone.
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
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
