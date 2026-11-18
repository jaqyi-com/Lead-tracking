# One image, four roles (ingest | api | worker | web) — boring, one thing to build and patch.
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/ingest/package.json apps/ingest/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_WS_URL=""
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
RUN pnpm --filter @lead/web build

FROM node:22-bookworm-slim
RUN corepack enable && useradd -r -u 10001 app
WORKDIR /app
COPY --from=build --chown=app /app /app
ENV NODE_ENV=production
USER app
# ROLE selects the process: ingest | api | worker | web | migrate
CMD ["sh", "-c", "case \"$ROLE\" in \
  ingest) exec pnpm --filter @lead/ingest start ;; \
  api) exec pnpm --filter @lead/api start ;; \
  worker) exec pnpm --filter @lead/worker start ;; \
  web) exec pnpm --filter @lead/web start ;; \
  migrate) exec pnpm db:migrate ;; \
  *) echo 'set ROLE' && exit 1 ;; esac"]
