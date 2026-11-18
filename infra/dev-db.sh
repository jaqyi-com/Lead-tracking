#!/usr/bin/env bash
# Local development Postgres on :5434 in .devdata/pg (no Docker needed).
#   bash infra/dev-db.sh start | stop | reset
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGDATA="$ROOT/.devdata/pg"
PORT="${DEV_PG_PORT:-5434}"
BIN="$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@16/bin/pg_ctl)")"

case "${1:-start}" in
  start)
    if [ ! -d "$PGDATA" ]; then
      mkdir -p "$PGDATA"
      "$BIN/initdb" -D "$PGDATA" -U lead --auth=trust --encoding=UTF8 >/dev/null
      echo "initialised $PGDATA"
    fi
    if ! "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
      "$BIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k /tmp" -l "$ROOT/.devdata/pg.log" -w start >/dev/null
    fi
    "$BIN/psql" -h localhost -p "$PORT" -U lead -d postgres -tc "select 1 from pg_database where datname='lead_os'" | grep -q 1 \
      || "$BIN/createdb" -h localhost -p "$PORT" -U lead lead_os
    echo "postgres://lead@localhost:$PORT/lead_os ready"
    ;;
  stop)
    "$BIN/pg_ctl" -D "$PGDATA" -w stop >/dev/null && echo stopped
    ;;
  reset)
    "$BIN/psql" -h localhost -p "$PORT" -U lead -d postgres -c "drop database if exists lead_os" -c "create database lead_os"
    ;;
esac
