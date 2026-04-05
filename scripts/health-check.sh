#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/docker/.env"

# Load environment variables
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set}"
POSTGRES_DB="${POSTGRES_DB:-vectormemory}"
POSTGRES_PORT="${POSTGRES_PORT:-54322}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "true" ] || [ "$result" = "t" ]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "Health Check — vectormemory-openclaw"
echo ""

# 1. PostgreSQL reachable
PG_READY=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -tAc "SELECT true;" 2>/dev/null || echo "false")
check "PostgreSQL reachable" "$PG_READY"

# 2. pgvector extension installed
PGVECTOR=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -tAc "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector');" 2>/dev/null || echo "false")
check "pgvector extension" "$PGVECTOR"

# 3. memories table exists
TABLE=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -tAc "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'memories');" 2>/dev/null || echo "false")
check "memories table" "$TABLE"

# 4. match_memories function exists
FUNC=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -tAc "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'match_memories');" 2>/dev/null || echo "false")
check "match_memories function" "$FUNC"

# 5. Ollama reachable (optional)
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
# Strip protocol for curl check
if curl -s --max-time 2 "$OLLAMA_URL/api/tags" &>/dev/null; then
  check "Ollama reachable" "true"
else
  echo "  ⚠ Ollama not reachable (optional)"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
