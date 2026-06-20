# The node alpine image is available here: https://github.com/nodejs/docker-node
FROM --platform=${TARGETPLATFORM:-linux/amd64} node:24-alpine AS alpine

# It's important to update the index before installing packages to ensure you're getting the latest versions.
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk update && apk upgrade --no-cache libcrypto3 libssl3 libc6-compat busybox ssl_client zlib

FROM --platform=${TARGETPLATFORM:-linux/amd64} alpine AS build-base
# Pin turbo to avoid nondeterministic prune output from future patch releases.
RUN npm install turbo@2.9.14 --global
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@11.4.0 --activate

FROM --platform=${TARGETPLATFORM:-linux/amd64} alpine AS runtime-base
# Remove build-only package managers. npm stays here because the runner stage
# uses it to install prisma and optional dd-trace before removing it.
RUN rm -rf /usr/local/lib/node_modules/corepack \
            /root/.cache/node/corepack && \
    rm -f /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

FROM --platform=${TARGETPLATFORM:-linux/amd64} build-base AS pruner

WORKDIR /app

COPY . .
RUN turbo prune --scope=web --docker

FROM --platform=${TARGETPLATFORM:-linux/amd64} build-base AS builder

WORKDIR /app

# First install the dependencies (as they change less often)
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /app/out/json/ .

# --config.minimumReleaseAge=0 skips pnpm's supply-chain age verification of every lockfile entry.
# This is a --frozen-lockfile install (resolves nothing, just materializes the committed+vetted
# lockfile), so the age gate adds no protection here — it only slows the build and would false-fail
# on a recently-added dep not yet in minimumReleaseAgeExclude. The gate stays enforced where it
# matters: non-frozen installs that update the lockfile.
RUN pnpm install --frozen-lockfile --config.minimumReleaseAge=0

ENV DOCKER_BUILD 1
ENV NEXT_MANUAL_SIG_HANDLE true

# Allows the CI docker build smoke test to skip the Next.js type check that
# the lint job already runs (`pnpm run typecheck`). Release builds do not set
# this and still fail on TypeScript errors.
ARG NEXT_IGNORE_BUILD_ERRORS
ENV NEXT_IGNORE_BUILD_ERRORS=$NEXT_IGNORE_BUILD_ERRORS

# pass public variables in build step
ARG NEXT_PUBLIC_PLAIN_APP_ID
ARG NEXT_PUBLIC_LANGFUSE_CLOUD_REGION
ENV NEXT_PUBLIC_LANGFUSE_CLOUD_REGION=$NEXT_PUBLIC_LANGFUSE_CLOUD_REGION
ARG NEXT_PUBLIC_DEMO_ORG_ID
ENV NEXT_PUBLIC_DEMO_ORG_ID=$NEXT_PUBLIC_DEMO_ORG_ID
ARG NEXT_PUBLIC_DEMO_PROJECT_ID
ENV NEXT_PUBLIC_DEMO_PROJECT_ID=$NEXT_PUBLIC_DEMO_PROJECT_ID
ARG NEXT_PUBLIC_SIGN_UP_DISABLED
ENV NEXT_PUBLIC_SIGN_UP_DISABLED=$NEXT_PUBLIC_SIGN_UP_DISABLED
ARG NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_LANGFUSE_TRACING_SAMPLE_RATE
ENV NEXT_PUBLIC_LANGFUSE_TRACING_SAMPLE_RATE=$NEXT_PUBLIC_LANGFUSE_TRACING_SAMPLE_RATE
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT
ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_BASE_PATH
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH

# Sentry already needs to be set on build time to upload sourcemaps
# This must not be set for OSS releases as we would share our Sentry secret.
ARG SENTRY_AUTH_TOKEN
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ENV SENTRY_ORG=$SENTRY_ORG
ARG SENTRY_PROJECT
ENV SENTRY_PROJECT=$SENTRY_PROJECT

# Accept build id as NEXT_PUBLIC_BUILD_ID
ARG NEXT_PUBLIC_BUILD_ID
ENV NEXT_PUBLIC_BUILD_ID=$NEXT_PUBLIC_BUILD_ID
ENV SENTRY_RELEASE=$NEXT_PUBLIC_BUILD_ID

# Copy source code of isolated subworkspace
COPY --from=pruner /app/out/full/ .

# remove middleware.ts if it exists - not needed in self-hosted environments
RUN rm -f ./web/src/middleware.ts

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED 1
ENV NEXT_MANUAL_SIG_HANDLE true
# set the CI flag to true to get CI specific logs
ENV CI true

RUN NODE_OPTIONS='--max-old-space-size-percentage=75' turbo run build --filter=web...

# Production image, copy all the files and run next
FROM --platform=${TARGETPLATFORM:-linux/amd64} runtime-base AS runner

ARG TARGETPLATFORM
ARG BUILDPLATFORM

WORKDIR /app

ARG NEXT_PUBLIC_BUILD_ID
ENV BUILD_ID=$NEXT_PUBLIC_BUILD_ID
ARG NEXT_PUBLIC_LANGFUSE_CLOUD_REGION
ENV NEXT_PUBLIC_LANGFUSE_CLOUD_REGION=$NEXT_PUBLIC_LANGFUSE_CLOUD_REGION

ENV NODE_ENV production
# Uncomment the following line in case you want to disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED 1
# Needed to re-enable validation of environment variables during runtime
ENV DOCKER_BUILD 0
# Set NEXT_MANUAL_SIG_HANDLE for runtime
ENV NEXT_MANUAL_SIG_HANDLE true

RUN apk add --no-cache dumb-init tzdata

# Don't run production as root
ARG UID=1001
ARG GID=1001
RUN addgroup --system --gid ${GID} nodejs
RUN adduser --system --uid ${UID} nextjs

RUN npm install -g --no-package-lock --no-save prisma@6.19.3

# Install dd-trace only if NEXT_PUBLIC_LANGFUSE_CLOUD_REGION is configured
ARG NEXT_PUBLIC_LANGFUSE_CLOUD_REGION
RUN if [ -n "$NEXT_PUBLIC_LANGFUSE_CLOUD_REGION" ]; then \
    npm install --no-package-lock --no-save dd-trace@5.97.0; \
    fi

COPY --from=builder --chown=nextjs:nodejs /app/web/next.config.mjs .
COPY --from=builder --chown=nextjs:nodejs /app/web/package.json .

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/static ./web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/web/public ./web/public

COPY --from=builder --chown=nextjs:nodejs /app/packages/shared/prisma ./packages/shared/prisma

COPY --chown=nextjs:nodejs ./web/entrypoint.sh ./web/entrypoint.sh
COPY --chown=nextjs:nodejs ./packages/shared/scripts/cleanup.sql ./packages/shared/scripts/cleanup.sql
RUN chmod +x ./web/entrypoint.sh

# GreptimeDB analytics-store migration runner, invoked by web/entrypoint.sh on startup. Self-contained
# (no tsx in production). Its mysql2 + pg deps install into an isolated /app/migrate-runtime with its
# own minimal package.json, so npm never walks up into the monorepo's workspace package.json (which
# would fail on `workspace:*` deps). npm is only used for these installs (and the prisma/dd-trace
# installs above), so remove it from the final runtime image afterwards.
RUN mkdir -p /app/migrate-runtime && \
    printf '{"name":"openfuse-migrate-runtime","private":true}\n' > /app/migrate-runtime/package.json && \
    npm install --prefix /app/migrate-runtime --no-package-lock --no-save --no-audit --no-fund mysql2@3.11.5 pg@8.13.0 && \
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=nextjs:nodejs ./scripts/greptime-migrate.mjs /app/migrate-runtime/greptime-migrate.mjs
COPY --chown=nextjs:nodejs ./packages/shared/greptime/migrations /app/migrate-runtime/migrations

# Pre-create the default local blob-store mount points owned by the app user so a fresh named volume
# (LANGFUSE_MEDIA_LOCAL_PATH / LANGFUSE_EVENT_LOCAL_PATH in docker-compose) inherits writable
# ownership. A root-owned volume mount otherwise makes the non-root runtime user fail to mkdir.
RUN mkdir -p /langfuse_media_data /langfuse_event_data && \
    chown nextjs:nodejs /langfuse_media_data /langfuse_event_data

USER nextjs

# Default port to 3000
ENV PORT 3000

# Docker ENTRYPOINT (dumb-init) is covered by semantic versioning, not the entrypoint.sh itself
# Reasoning: ENTRYPOINT is overridden by some self-hosted deployments, thus changing this is breaking
ENTRYPOINT ["dumb-init", "--", "./web/entrypoint.sh"]

# startup command - use dd-trace if NEXT_PUBLIC_LANGFUSE_CLOUD_REGION is configured
CMD if [ -n "$NEXT_PUBLIC_LANGFUSE_CLOUD_REGION" ]; then \
    node --import dd-trace/initialize.mjs ./web/server.js --keepAliveTimeout 110000; \
    else \
    node ./web/server.js --keepAliveTimeout 110000; \
    fi
