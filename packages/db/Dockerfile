# syntax=docker/dockerfile:1
#
# Інструменти БД для розгорнутих середовищ: міграції (за замовчуванням) і
# seed. Контекст — корінь монорепо:
#   docker build -f packages/db/Dockerfile -t store-db-tools .
#
# Міграції: роль store_migrate (DATABASE_MIGRATE_URL) — default privileges
# для store_app видані саме їй. Seed: роль store_app (DATABASE_URL) +
# APP_ENV; у production seed відмовляє сам.
#   docker compose run --rm -w /repo/packages/db -e APP_ENV=... -e DATABASE_URL=... \
#     -e EMAIL_TO_OVERRIDE=... migrate node --import tsx seed/index.ts

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
# Dev-залежності потрібні (seed запускається через tsx), тому NODE_ENV=production
# виставляється лише ПІСЛЯ встановлення.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @store/db...
ENV NODE_ENV=production

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db

USER node
# Node 24 запускає TypeScript напряму (type stripping).
CMD ["node", "packages/db/src/migrate.ts"]
