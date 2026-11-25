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
  // Server-rendered 404 for a dynamic root layout (app/global-not-found.tsx).
  // `proxy.ts` runs on every path, so Next buffers each request body in memory for it (default
  // 10 MB, kept per request until the route reads it): 30 parallel 60 MB streams took the process
  // from 119 MB to 513 MB. No route here takes more than a few KB (the largest is a checkout
  // form), so the buffer is small. This is the FIRST defence; the webhook cap is the second.
  experimental: { globalNotFound: true, proxyClientMaxBodySize: '64kb' },
  // Пакети монорепо — TypeScript-джерела, їх компілює Next.
  transpilePackages: [
    '@store/shared',
    '@store/db',
    '@store/core',
    '@store/payments',
    '@store/media',
  ],
  // sharp is a native module: it stays outside the bundle.
  serverExternalPackages: ['sharp'],
  headers: () =>
    Promise.resolve([
      {
        // The admin is never cached or indexed (proxy.ts sets the same; this one covers a path the
        // proxy does not see as admin). Declared first so the general block below only adds.
        source: '/admin/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // No includeSubDomains / preload: those are hard to undo and the
          // staging host shares a parent domain with other services.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        ],
      },
    ]),
  images: {
    // `domains` у 16 немає. Хости R2 / CDN додаються разом із packages/media.
    remotePatterns: [],
    // Явно: за замовчуванням лише [75] (AGENTS.md §4).
    qualities: [75],
  },
};

export default withNextIntl(nextConfig);
