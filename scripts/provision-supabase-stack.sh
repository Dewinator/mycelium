#!/usr/bin/env bash
# provision-supabase-stack.sh
#   Hard-isolation: zweite Supabase-Instanz fuer mycelium.
#   Eigener Docker-Stack auf Port-Offset, eigenes Volume, eigene service-role-JWT,
#   alle Migrationen aus supabase/migrations/ eingespielt.
#
# Aufruf:
#   scripts/provision-supabase-stack.sh --label=bundle [--port-offset=100] [--force]
#
# State liegt in:
#   ~/.mycelium-instances/<label>/{.env, docker-compose.yml, instance.json}
#
# Output (am Ende, parseable):
#   SUPABASE_URL=...
#   SUPABASE_KEY=...
set -euo pipefail

LABEL=""
PORT_OFFSET=100
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --label=*)        LABEL="${arg#*=}" ;;
    --port-offset=*)  PORT_OFFSET="${arg#*=}" ;;
    --force)          FORCE=1 ;;
    --help|-h)        sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

[[ -z "$LABEL" ]] && { echo "--label required" >&2; exit 2; }
[[ "$LABEL" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { echo "label must be [a-z0-9-], 2-31 chars" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$HOME/.mycelium-instances/$LABEL"
COMPOSE_PROJECT="mycelium-$LABEL"
API_PORT=$((54321 + PORT_OFFSET))
DB_PORT=$((54322 + PORT_OFFSET))
DB_NAME="vectormemory_${LABEL//-/_}"

# ── Existenz-Check ───────────────────────────────────────
if [[ -d "$STATE_DIR" && "$FORCE" -ne 1 ]]; then
  echo "State-Dir existiert: $STATE_DIR" >&2
  echo "  use --force to overwrite (zerstoert das Volume nicht — nur die Konfig)" >&2
  exit 3
fi

# Port-Konflikte abfangen, BEVOR irgendwas geschrieben wird
for p in "$API_PORT" "$DB_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p ist belegt — anderen --port-offset waehlen" >&2
    exit 4
  fi
done

mkdir -p "$STATE_DIR"

# ── .env generieren ──────────────────────────────────────
RANDOM_PW=$(openssl rand -base64 24 | tr -d '=/+' | head -c 32)
RANDOM_JWT=$(openssl rand -base64 48 | tr -d '=/+' | head -c 48)

cat > "$STATE_DIR/.env" <<EOF
# mycelium instance: $LABEL
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$RANDOM_PW
POSTGRES_DB=$DB_NAME
POSTGRES_PORT=$DB_PORT
API_PORT=$API_PORT
JWT_SECRET=$RANDOM_JWT
OLLAMA_URL=http://host.docker.internal:11434
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT
EOF
chmod 600 "$STATE_DIR/.env"

# ── docker-compose ableiten (container_name entfernen, sonst Kollision mit main) ──
sed '/^[[:space:]]*container_name:/d' "$REPO_DIR/docker/docker-compose.yml" > "$STATE_DIR/docker-compose.yml"

# ── Stack starten ────────────────────────────────────────
echo "→ Starting Docker stack '$COMPOSE_PROJECT' (api:$API_PORT, db:$DB_PORT)..."
(cd "$STATE_DIR" && docker compose --env-file .env up -d)

# ── auf Postgres warten ──────────────────────────────────
echo "→ Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if (cd "$STATE_DIR" && docker compose exec -T db pg_isready -U postgres -d "$DB_NAME" &>/dev/null); then
    echo "  ✓ ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "  ✗ Postgres did not become ready" >&2
    exit 5
  fi
  sleep 1
done

# ── Migrationen einspielen ───────────────────────────────
echo "→ Applying migrations..."
APPLIED=0
for migration in "$REPO_DIR/supabase/migrations"/*.sql; do
  name="$(basename "$migration")"
  PGPASSWORD="$RANDOM_PW" psql \
    -h localhost -p "$DB_PORT" -U postgres -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -f "$migration" --quiet \
    || { echo "  ✗ $name failed" >&2; exit 6; }
  APPLIED=$((APPLIED+1))
done
echo "  ✓ $APPLIED migrations applied"

# ── PostgREST schema-cache reloaden ──────────────────────
# PostgREST hat sein Schema beim Start gecached (vor den Migrationen) — ohne
# Reload schlaegt der erste INSERT mit 404 fehl ("schema cache lookup").
PGPASSWORD="$RANDOM_PW" psql -h localhost -p "$DB_PORT" -U postgres -d "$DB_NAME" \
  -c "NOTIFY pgrst, 'reload schema';" --quiet >/dev/null
sleep 2

# ── service-role-JWT generieren ──────────────────────────
SERVICE_KEY=$(JWT_SECRET="$RANDOM_JWT" node "$SCRIPT_DIR/lib/sign-jwt.mjs" service_role)
SUPABASE_URL="http://localhost:$API_PORT"

# ── instance.json schreiben ──────────────────────────────
cat > "$STATE_DIR/instance.json" <<EOF
{
  "label": "$LABEL",
  "supabase_url": "$SUPABASE_URL",
  "supabase_key": "$SERVICE_KEY",
  "compose_project": "$COMPOSE_PROJECT",
  "state_dir": "$STATE_DIR",
  "api_port": $API_PORT,
  "db_port": $DB_PORT,
  "db_name": "$DB_NAME",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
chmod 600 "$STATE_DIR/instance.json"

# ── Sanity: API erreichbar? ──────────────────────────────
sleep 1
if ! curl -fsS -H "apikey: $SERVICE_KEY" "$SUPABASE_URL/" >/dev/null 2>&1; then
  echo "  ⚠ API noch nicht erreichbar — PostgREST braucht u.U. ein paar Sekunden mehr" >&2
fi

cat <<EOF

=== ready ===
SUPABASE_URL=$SUPABASE_URL
SUPABASE_KEY=$SERVICE_KEY

State-Dir: $STATE_DIR
Stop:      (cd $STATE_DIR && docker compose down)
Restart:   (cd $STATE_DIR && docker compose up -d)

Naechster Schritt — Workspace + LaunchAgents fuer diese Instanz:

  node $SCRIPT_DIR/provision-instance.mjs --label=$LABEL \\
    --supabase-url='$SUPABASE_URL' \\
    --supabase-key='$SERVICE_KEY'

Danach in der OpenClaw-Bundle-MCP-Konfig den vector-memory-Eintrag auf
\$HOME/.openclaw-$LABEL/.mcp.json umbiegen (oder den env-Block direkt
in die OpenClaw-Bundle-Config kopieren).
EOF
