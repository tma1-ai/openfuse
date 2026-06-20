#!/bin/sh
set -e

# Entrypoint for the single-container Openfuse standalone image. Mirrors web/entrypoint.sh's database
# bootstrap (it is the only image that runs both web and worker, so it owns all startup migrations),
# then hands off to the process supervisor via `exec "$@"`.
#
# Order matters: Postgres schema first (the app's relational store + auth), then the GreptimeDB
# analytics schema, then start the long-running processes. Either migration failing aborts startup
# (set -e) so the container does not come up against an un-migrated store.

# Build DATABASE_URL from parts if not provided (same contract as web/worker entrypoints).
if [ -z "$DATABASE_URL" ]; then
    if [ -n "$DATABASE_HOST" ] && [ -n "$DATABASE_USERNAME" ] && [ -n "$DATABASE_PASSWORD" ] && [ -n "$DATABASE_NAME" ]; then
        DATABASE_URL="postgresql://${DATABASE_USERNAME}:${DATABASE_PASSWORD}@${DATABASE_HOST}/${DATABASE_NAME}"
        export DATABASE_URL
        if [ -n "$DATABASE_ARGS" ]; then
            DATABASE_URL="${DATABASE_URL}?$DATABASE_ARGS"
            export DATABASE_URL
        fi
    else
        echo "Error: Required database environment variables are not set. Provide a postgres url for DATABASE_URL."
        exit 1
    fi
fi

# DIRECT_URL is required for prisma migrations and the GreptimeDB advisory lock.
if [ -z "$DIRECT_URL" ]; then
    export DIRECT_URL="${DATABASE_URL}"
fi

# 1. Postgres migrations (gated, fail-closed).
if [ "$LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED" != "true" ]; then
    echo "[standalone] applying Postgres migrations..."
    prisma db execute --url "$DIRECT_URL" --file "./packages/shared/scripts/cleanup.sql"
    prisma migrate deploy --schema=./packages/shared/prisma/schema.prisma
fi

# 2. GreptimeDB analytics-store migrations (gated, fail-closed). Idempotent + serialised by a
#    Postgres advisory lock; safe to re-run on every start and across replicas.
if [ "$LANGFUSE_AUTO_GREPTIME_MIGRATION_DISABLED" != "true" ]; then
    echo "[standalone] applying GreptimeDB migrations..."
    GREPTIME_MIGRATIONS_DIR="${GREPTIME_MIGRATIONS_DIR:-/app/migrate-runtime/migrations}" \
        node /app/migrate-runtime/greptime-migrate.mjs
fi

# 3. Start web + worker under the supervisor.
exec "$@"
