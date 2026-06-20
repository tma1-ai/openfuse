#!/bin/sh
# GreptimeDB container entrypoint for Openfuse.
#
# Wraps `greptime standalone start` to optionally enable static-user authentication driven by the
# GREPTIME_USER / GREPTIME_PASSWORD environment variables, so the same image and Compose definition
# serve both an unauthenticated local node (no password -> auth off, frictionless dev/quickstart)
# and a secured deployment (password set -> enforced static auth). GreptimeDB only authenticates
# when started with `--user-provider`, so setting credentials on the app side alone is not enough;
# this script generates the credentials file and wires the provider.
set -eu

umask 077

GREPTIME_USER="${GREPTIME_USER:-openfuse}"
GREPTIME_PASSWORD="${GREPTIME_PASSWORD:-}"
AUTH_FILE="/tmp/greptime-users"

# Resolve the greptime binary even if the image's default entrypoint differs from PATH.
GREPTIME_BIN="$(command -v greptime || echo /greptime/bin/greptime)"

AUTH_ARGS=""
if [ -n "$GREPTIME_PASSWORD" ]; then
  # The credentials file is line-based (`username=verifier` per line). GreptimeDB parses each line
  # with a plain `split("=")`, so `=` breaks the line, and CR/LF could inject extra accounts.
  # tr-strip-and-compare catches both embedded and trailing newlines (command substitution alone
  # would not).
  if [ "$(printf '%s' "$GREPTIME_USER" | tr -d '\r\n')" != "$GREPTIME_USER" ] ||
    [ "$(printf '%s' "$GREPTIME_PASSWORD" | tr -d '\r\n')" != "$GREPTIME_PASSWORD" ]; then
    echo "[openfuse] error: GREPTIME_USER / GREPTIME_PASSWORD must not contain newlines" >&2
    exit 1
  fi
  case "$GREPTIME_PASSWORD" in
    *=*)
      echo "[openfuse] error: GREPTIME_PASSWORD must not contain '=' because GreptimeDB static auth uses username=password lines" >&2
      exit 1
      ;;
  esac
  # Constrain the username to a simple token: a leading alnum/underscore, then alnum/_/./- .
  case "$GREPTIME_USER" in
    "" | [!A-Za-z0-9_]* | *[!A-Za-z0-9_.-]*)
      echo "[openfuse] error: GREPTIME_USER must match [A-Za-z0-9_][A-Za-z0-9_.-]*" >&2
      exit 1
      ;;
  esac

  printf '%s=plain:%s\n' "$GREPTIME_USER" "$GREPTIME_PASSWORD" >"$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
  AUTH_ARGS="--user-provider=static_user_provider:file:$AUTH_FILE"
  echo "[openfuse] GreptimeDB static auth enabled for user '$GREPTIME_USER'"
else
  echo "[openfuse] GreptimeDB auth disabled (GREPTIME_PASSWORD empty) — do not expose this node" >&2
fi

# shellcheck disable=SC2086 # AUTH_ARGS must word-split (empty -> no flag, set -> one flag).
exec "$GREPTIME_BIN" standalone start \
  --config-file=/etc/greptime/config.toml \
  --http-addr=0.0.0.0:4000 \
  --rpc-bind-addr=0.0.0.0:4001 \
  --mysql-addr=0.0.0.0:4002 \
  --postgres-addr=0.0.0.0:4003 \
  --data-home=/greptimedb_data \
  $AUTH_ARGS
