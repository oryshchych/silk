# syntax=docker/dockerfile:1
#
# Образ вітрини. Контекст — корінь монорепо:
#   docker build -f apps/web/Dockerfile -t store-web .
#
# ADR-10: ОДИН образ для staging і production; усе, що відрізняється між
# середовищами, приходить змінними оточення під час запуску. Виняток —
# NEXT_PUBLIC_SITE_URL: він вшивається в клієнтський бандл на етапі збірки.
#
# Debian slim, а не Alpine: той самий glibc, що в CI й локально, без
# сюрпризів musl для нативних модулів (sharp). Архітектура — та, на якій
# збирається (на сервері Hetzner CAX — arm64).

ARG NODE_VERSION=24

# ── 1. Залежності ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Лише маніфести: шар із залежностями кешується, поки не змінився lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
# --ignore-scripts: postinstall не потрібні (бінарники — optional-пакети
# платформи), а `prepare` (lefthook) без .git впав би.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter web...

# ── 2. Збірка ────────────────────────────────────────────────────────────
FROM deps AS build
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter web build

# ── 3. Запуск ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app

# standalone містить server.js і лише ті файли node_modules, які трасувались.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

# Не root: компрометація процесу не дає root у контейнері.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/web/server.js"]
