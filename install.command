#!/bin/bash
#
# vectormemory-openclaw — One-Click Installer for macOS
#
# Double-click this file in Finder to install everything.
# Or run from Terminal:  ./install.command
#

set -euo pipefail

# cd into the directory where this script lives
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

clear
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║     vectormemory-openclaw Installer                      ║"
echo "║     Vector Memory for openClaw via Supabase + pgvector   ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────────────
# 1. Check & install prerequisites
# ─────────────────────────────────────────────────────────────

echo "▸ Checking prerequisites..."
echo ""

MISSING=0

# Homebrew
if ! command -v brew &>/dev/null; then
  echo "  ✗ Homebrew not found."
  echo "    Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  echo ""
fi
echo "  ✓ Homebrew"

# Docker
if ! command -v docker &>/dev/null; then
  echo "  ✗ Docker not found."
  echo ""
  echo "  Docker Desktop must be installed manually:"
  echo "  → https://www.docker.com/products/docker-desktop/"
  echo ""
  echo "  Install it, start it, then run this installer again."
  echo ""
  read -p "  Press Enter to open the download page..."
  open "https://www.docker.com/products/docker-desktop/"
  exit 1
fi
echo "  ✓ Docker"

if ! docker info &>/dev/null 2>&1; then
  echo ""
  echo "  ✗ Docker is installed but not running."
  echo "    Please start Docker Desktop and run this installer again."
  echo ""
  read -p "  Press Enter to exit..."
  exit 1
fi
echo "  ✓ Docker is running"

# Node.js
if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Installing via Homebrew..."
  brew install node
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "  ✗ Node.js version is too old ($NODE_VERSION). Upgrading..."
  brew upgrade node
fi
echo "  ✓ Node.js $(node -v)"

# psql
if ! command -v psql &>/dev/null; then
  echo "  ✗ psql not found. Installing via Homebrew..."
  brew install postgresql
fi
echo "  ✓ psql"

# Ollama
if ! command -v ollama &>/dev/null; then
  echo "  ✗ Ollama not found. Installing via Homebrew..."
  brew install ollama
fi
echo "  ✓ Ollama"

# Ensure Ollama is running
if ! curl -s --max-time 2 http://localhost:11434/api/tags &>/dev/null; then
  echo "  → Starting Ollama..."
  ollama serve &>/dev/null &
  sleep 3
fi

# Pull embedding model
if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
  echo "  → Pulling nomic-embed-text embedding model (~270 MB)..."
  ollama pull nomic-embed-text
fi
echo "  ✓ nomic-embed-text model"

echo ""
echo "  All prerequisites met."
echo ""

# ─────────────────────────────────────────────────────────────
# 2. Create .env with secure random secrets
# ─────────────────────────────────────────────────────────────

ENV_FILE="$PROJECT_DIR/docker/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "▸ Generating secure configuration..."
  cp "$PROJECT_DIR/docker/.env.example" "$ENV_FILE"

  RANDOM_PW=$(openssl rand -base64 24 | tr -d '=/+' | head -c 32)
  RANDOM_JWT=$(openssl rand -base64 48 | tr -d '=/+' | head -c 48)

  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/CHANGE_ME_to_a_secure_password/$RANDOM_PW/" "$ENV_FILE"
    sed -i '' "s/CHANGE_ME_to_at_least_32_chars_random_string/$RANDOM_JWT/" "$ENV_FILE"
  else
    sed -i "s/CHANGE_ME_to_a_secure_password/$RANDOM_PW/" "$ENV_FILE"
    sed -i "s/CHANGE_ME_to_at_least_32_chars_random_string/$RANDOM_JWT/" "$ENV_FILE"
  fi

  echo "  ✓ docker/.env created with random secrets"
else
  echo "▸ Configuration already exists (docker/.env)"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# 3. Start Docker containers
# ─────────────────────────────────────────────────────────────

echo "▸ Starting Supabase (PostgreSQL + pgvector)..."
cd "$PROJECT_DIR/docker"
docker compose up -d 2>&1 | grep -v "^$"
echo "  ✓ Containers started"

# Wait for PostgreSQL
echo "  → Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U postgres &>/dev/null; then
    echo "  ✓ PostgreSQL is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  ✗ PostgreSQL did not start in time. Check: docker compose logs"
    read -p "  Press Enter to exit..."
    exit 1
  fi
  sleep 1
done

echo ""

# ─────────────────────────────────────────────────────────────
# 4. Run database migrations
# ─────────────────────────────────────────────────────────────

echo "▸ Running database migrations..."
cd "$PROJECT_DIR"

# Load env
set -a
source "$PROJECT_DIR/docker/.env"
set +a

for migration in supabase/migrations/*.sql; do
  filename="$(basename "$migration")"
  echo "  → $filename"
  PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h localhost \
    -p "${POSTGRES_PORT:-54322}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-vectormemory}" \
    -f "$migration" \
    --quiet 2>&1 | grep -v "^$" || true
done
echo "  ✓ All migrations applied"

echo ""

# ─────────────────────────────────────────────────────────────
# 5. Build MCP server
# ─────────────────────────────────────────────────────────────

echo "▸ Building MCP server..."
cd "$PROJECT_DIR/mcp-server"
npm install --silent 2>&1 | tail -1
npm run build 2>&1 | tail -1
echo "  ✓ MCP server built"

echo ""

# ─────────────────────────────────────────────────────────────
# 6. Health check
# ─────────────────────────────────────────────────────────────

echo "▸ Running health check..."

PASS=0
FAIL=0

check() {
  if [ "$2" = "true" ] || [ "$2" = "t" ]; then
    echo "  ✓ $1"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $1"
    FAIL=$((FAIL + 1))
  fi
}

PG_READY=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p "${POSTGRES_PORT:-54322}" -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-vectormemory}" -tAc "SELECT true;" 2>/dev/null || echo "false")
check "PostgreSQL" "$PG_READY"

PGVECTOR=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p "${POSTGRES_PORT:-54322}" -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-vectormemory}" -tAc "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector');" 2>/dev/null || echo "false")
check "pgvector extension" "$PGVECTOR"

TABLE=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p "${POSTGRES_PORT:-54322}" -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-vectormemory}" -tAc "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'memories');" 2>/dev/null || echo "false")
check "memories table" "$TABLE"

FUNC=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p "${POSTGRES_PORT:-54322}" -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-vectormemory}" -tAc "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'match_memories');" 2>/dev/null || echo "false")
check "match_memories function" "$FUNC"

if curl -s --max-time 2 http://localhost:11434/api/tags &>/dev/null; then
  check "Ollama" "true"
else
  echo "  ⚠ Ollama not reachable"
fi

MCP_PATH="$PROJECT_DIR/mcp-server/dist/index.js"
if [ -f "$MCP_PATH" ]; then
  check "MCP server binary" "true"
else
  check "MCP server binary" "false"
fi

echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  $FAIL checks failed. Please fix the issues above and run again."
  read -p "  Press Enter to exit..."
  exit 1
fi

# ─────────────────────────────────────────────────────────────
# 7. Generate openClaw config
# ─────────────────────────────────────────────────────────────

# Read JWT_SECRET from .env
JWT_SECRET=$(grep "^JWT_SECRET=" "$PROJECT_DIR/docker/.env" | cut -d= -f2)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                  Installation complete!                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  $PASS/$PASS health checks passed."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NEXT STEP: Add this to your openClaw settings.json:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
cat <<JSONEOF
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["$MCP_PATH"],
      "env": {
        "SUPABASE_URL": "http://localhost:54321",
        "SUPABASE_KEY": "$JWT_SECRET",
        "OLLAMA_URL": "http://localhost:11434",
        "EMBEDDING_MODEL": "nomic-embed-text",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
JSONEOF
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Copy config to clipboard if possible
CONFIG=$(cat <<JSONEOF2
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["$MCP_PATH"],
      "env": {
        "SUPABASE_URL": "http://localhost:54321",
        "SUPABASE_KEY": "$JWT_SECRET",
        "OLLAMA_URL": "http://localhost:11434",
        "EMBEDDING_MODEL": "nomic-embed-text",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
JSONEOF2
)

if command -v pbcopy &>/dev/null; then
  echo "$CONFIG" | pbcopy
  echo "  Config has been copied to your clipboard!"
  echo "  Just paste it into your openClaw settings.json."
else
  echo "  Copy the JSON block above into your openClaw settings.json."
fi

echo ""
echo "  After a Mac restart, run:"
echo "  cd $PROJECT_DIR/docker && docker compose up -d"
echo ""
read -p "  Press Enter to close..."
