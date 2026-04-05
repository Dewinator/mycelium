#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== vectormemory-openclaw Setup ==="
echo ""

# ── Check prerequisites ──────────────────────────────────
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: $1 is not installed. $2"
    exit 1
  fi
  echo "  ✓ $1 found"
}

echo "Checking prerequisites..."
check_cmd docker "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
check_cmd node "Install Node.js >= 20: https://nodejs.org/"
check_cmd psql "Install via: brew install postgresql (needed for migrations)"

# Check Docker is running
if ! docker info &>/dev/null; then
  echo "ERROR: Docker is not running. Start Docker Desktop first."
  exit 1
fi
echo "  ✓ Docker is running"

# Check Ollama (optional but recommended)
if command -v ollama &>/dev/null; then
  echo "  ✓ Ollama found"
  if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
    echo "  → Pulling nomic-embed-text model..."
    ollama pull nomic-embed-text
  else
    echo "  ✓ nomic-embed-text model available"
  fi
else
  echo "  ⚠ Ollama not found (optional). Install: brew install ollama"
fi

echo ""

# ── Create .env if missing ───────────────────────────────
ENV_FILE="$PROJECT_DIR/docker/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Creating docker/.env from template..."
  cp "$PROJECT_DIR/docker/.env.example" "$ENV_FILE"
  # Generate random password and JWT secret
  RANDOM_PW=$(openssl rand -base64 24 | tr -d '=/+' | head -c 32)
  RANDOM_JWT=$(openssl rand -base64 48 | tr -d '=/+' | head -c 48)
  sed -i.bak "s/CHANGE_ME_to_a_secure_password/$RANDOM_PW/" "$ENV_FILE"
  sed -i.bak "s/CHANGE_ME_to_at_least_32_chars_random_string/$RANDOM_JWT/" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
  echo "  ✓ docker/.env created with random secrets"
else
  echo "  ✓ docker/.env already exists"
fi

echo ""

# ── Start Docker containers ──────────────────────────────
echo "Starting Supabase (PostgreSQL + pgvector)..."
cd "$PROJECT_DIR/docker"
docker compose up -d
echo "  ✓ Containers started"

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U postgres &>/dev/null; then
    echo "  ✓ PostgreSQL is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: PostgreSQL did not become ready in time."
    exit 1
  fi
  sleep 1
done

echo ""

# ── Run migrations ───────────────────────────────────────
echo "Running database migrations..."
bash "$SCRIPT_DIR/migrate.sh"

echo ""

# ── Build MCP server (if package.json exists) ────────────
if [ -f "$PROJECT_DIR/mcp-server/package.json" ]; then
  echo "Building MCP server..."
  cd "$PROJECT_DIR/mcp-server"
  npm install
  npm run build
  echo "  ✓ MCP server built"
  MCP_PATH="$PROJECT_DIR/mcp-server/dist/index.js"
else
  echo "  ⚠ MCP server not yet created (M2)"
  MCP_PATH="/pfad/zu/vectormemory-openclaw/mcp-server/dist/index.js"
fi

echo ""

# ── Health check ─────────────────────────────────────────
echo "Running health check..."
bash "$SCRIPT_DIR/health-check.sh"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Add this to your openClaw settings.json:"
echo ""
echo "  {\"mcpServers\": {\"vector-memory\": {\"command\": \"node\", \"args\": [\"$MCP_PATH\"]}}}"
echo ""
