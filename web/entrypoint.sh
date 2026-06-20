#!/bin/sh

# Check whether a database URL's credentials contain characters that typically
# need percent-encoding for Prisma (@ : / % # ?).  Best-effort heuristic —
# strips the scheme, extracts the authority (user:pass@host) before the first
# slash, and checks for common offenders.  Strips %XX sequences first so
# partially-encoded values are caught.
check_unencoded_credentials() {
    _url="$1"
    _no_scheme="${_url#*://}"
    # Extract authority (before first /) so @/# in path or query params
    # don't confuse credential parsing.
    _authority="${_no_scheme%%/*}"
    case "$_authority" in
        *@*)
            _host_part="${_authority##*@}"
            _creds="${_authority%@"$_host_part"}"
            _user="${_creds%%:*}"
            _pass="${_creds#*:}"
            _found=""
            for _val in "$_user" "$_pass"; do
                # Strip valid percent-encoded sequences before checking so
                # partially-encoded values like p%40ss@word are still caught.
                _stripped=$(printf '%s' "$_val" | sed 's/%[0-9A-Fa-f][0-9A-Fa-f]//g')
                case "$_stripped" in
                    *@*|*:*|*/*|*%*|*'#'*|*'?'*) _found="true" ;;
                esac
            done
            if [ "$_found" = "true" ]; then
                echo "HINT: Your DATABASE_URL / DIRECT_URL credentials appear to contain special characters (@, :, /, %, #, ?) that are not URL-encoded."
                echo "  Prisma requires these to be percent-encoded, otherwise you will see P1013 errors."
                echo "  Example: p@ssword → p%40ssword"
                echo "  Reference: https://www.prisma.io/docs/orm/reference/connection-urls#special-characters"
            fi
            ;;
    esac
}

# Run cleanup script before running migrations
# Check if DATABASE_URL is not set
if [ -z "$DATABASE_URL" ]; then
    # Check if all required variables are provided
    if [ -n "$DATABASE_HOST" ] && [ -n "$DATABASE_USERNAME" ] && [ -n "$DATABASE_PASSWORD" ]  && [ -n "$DATABASE_NAME" ]; then
        # Construct DATABASE_URL from the provided variables
        DATABASE_URL="postgresql://${DATABASE_USERNAME}:${DATABASE_PASSWORD}@${DATABASE_HOST}/${DATABASE_NAME}"
        export DATABASE_URL
    else
        echo "Error: Required database environment variables are not set. Provide a postgres url for DATABASE_URL."
        exit 1
    fi
    if [ -n "$DATABASE_ARGS" ]; then
        # Append ARGS to DATABASE_URL
        DATABASE_URL="${DATABASE_URL}?$DATABASE_ARGS"
        export DATABASE_URL
    fi
fi

# Set DIRECT_URL to the value of DATABASE_URL if it is not set, required for migrations
if [ -z "$DIRECT_URL" ]; then
    export DIRECT_URL="${DATABASE_URL}"
fi

# Always execute the postgres migration, except when disabled.
status=0
if [ "$LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED" != "true" ]; then
    prisma db execute --url "$DIRECT_URL" --file "./packages/shared/scripts/cleanup.sql"

    # Apply migrations
    prisma migrate deploy --schema=./packages/shared/prisma/schema.prisma
    status=$?
fi

# If migration fails (returns non-zero exit status), exit script with that status
if [ $status -ne 0 ]; then
    echo "Applying database migrations failed. Common causes:"
    echo "  1. The database is unavailable or unreachable."
    echo "  2. DATABASE_URL / DIRECT_URL credentials contain special characters that are not URL-encoded."
    check_unencoded_credentials "$DIRECT_URL"
    echo "Exiting..."
    exit $status
fi

# Apply the GreptimeDB analytics-store schema (gated, fail-closed). Mirrors the upstream Langfuse
# contract where ClickHouse migrations also run from the web entrypoint. Idempotent + serialised by a
# Postgres advisory lock, so it is safe to re-run on every start and across replicas. The runner is a
# self-contained node script (no tsx in the production image); its mysql2 + pg deps live under
# /app/migrate-runtime, separate from the Next standalone tree.
if [ "$LANGFUSE_AUTO_GREPTIME_MIGRATION_DISABLED" != "true" ]; then
    echo "Applying GreptimeDB migrations..."
    if ! GREPTIME_MIGRATIONS_DIR="${GREPTIME_MIGRATIONS_DIR:-/app/migrate-runtime/migrations}" \
        node /app/migrate-runtime/greptime-migrate.mjs; then
        echo "Applying GreptimeDB migrations failed. Exiting..."
        exit 1
    fi
fi

# Run the command passed to the docker image on start
exec "$@"
