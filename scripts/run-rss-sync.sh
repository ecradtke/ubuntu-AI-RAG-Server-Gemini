#!/usr/bin/env bash
# systemd ExecStart for k13-rss-sync (run every 5 minutes by k13-rss-sync.timer)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
load_k13_env
PY="$BASE_DIR/.venv/bin/python"
[[ -x "$PY" ]] || die "Project venv missing (run scripts/install.sh)"
# Forward configuration keys from .env
for k in FRESHRSS_BASE_URL FRESHRSS_USER FRESHRSS_API_PASS FRESHRSS_PASSWORD \
         PG_HOST PG_PORT PG_DB PG_USER PG_PASS PG_PASSWORD PG_DBNAME \
         POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD \
         NAS_HOST NAS_IP DB_HOST DB_USER DB_PASS DB_PASSWORD PGPASSWORD; do
  val="$(env_get "$k" "")"
  if [[ -n "$val" ]]; then
    export "$k=$val"
  fi
done

# Ensure PGPASSWORD and PG_PASS/PG_PASSWORD are mutually exported if any one is present
for p in PG_PASS PG_PASSWORD POSTGRES_PASSWORD DB_PASS DB_PASSWORD PGPASSWORD; do
  pv="$(env_get "$p" "")"
  if [[ -n "$pv" ]]; then
    export PG_PASS="$pv"
    export PG_PASSWORD="$pv"
    export PGPASSWORD="$pv"
    break
  fi
done

export EMBEDDING_HOST="http://127.0.0.1:${OV_PORT}" OLLAMA_HOST="http://127.0.0.1:${OV_PORT}"
export EMBED_MODEL="$(env_get EMBED_MODEL "BAAI/bge-base-en-v1.5")"
export QDRANT_HOST=127.0.0.1 QDRANT_PORT="$QDRANT_PORT"
export PYTHONUNBUFFERED=1
exec "$PY" "$BASE_DIR/rss/sync_freshrss.py"
