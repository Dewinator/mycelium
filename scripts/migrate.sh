#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$PROJECT_DIR/supabase/migrations"
ENV_FILE="$PROJECT_DIR/docker/.env"

# Load environment variables
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set. Copy docker/.env.example to docker/.env}"
POSTGRES_DB="${POSTGRES_DB:-vectormemory}"
POSTGRES_PORT="${POSTGRES_PORT:-54322}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"

echo "Running migrations against $POSTGRES_DB on $POSTGRES_HOST:$POSTGRES_PORT..."

for migration in "$MIGRATIONS_DIR"/*.sql; do
  filename="$(basename "$migration")"
  echo "  Applying $filename..."
  PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -f "$migration" \
    --quiet
done

echo "All migrations applied successfully."
