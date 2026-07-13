#!/usr/bin/env bash
# Salto installer — sets up and starts Salto with Docker Compose.
#
#   curl -fsSL https://raw.githubusercontent.com/Stevy2191/salto/main/install.sh | bash
#
# Interactive prompts read from the terminal even when piped from curl.
# Non-interactive use: preset answers via environment variables, e.g.
#   SALTO_PORT=8080 bash install.sh
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/Stevy2191/salto/main"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
note()  { printf '  %s\n' "$*"; }
warn()  { printf '\033[33m! %s\033[0m\n' "$*"; }
fail()  { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }

# Ask a question on the controlling terminal; fall back to the default when
# no terminal is available (CI, curl | bash without a tty). Stdout carries
# only the answer — callers capture it with $(ask …).
ask() {
  local question=$1 default=$2 answer=''
  if [ -t 0 ]; then
    read -r -p "$question [$default]: " answer
  elif (: </dev/tty) 2>/dev/null; then
    read -r -p "$question [$default]: " answer </dev/tty 2>/dev/tty || answer=''
  else
    note "$question → using default: $default" >&2
  fi
  printf '%s' "${answer:-$default}"
}

bold "Salto installer"

# --- Prerequisites ---------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed. Install it from https://docs.docker.com/engine/install/ and run this script again."
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "Docker Compose is not installed. It ships with Docker Desktop, or see https://docs.docker.com/compose/install/."
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not reachable. Is the Docker daemon running? If it's a permission error, add yourself to the docker group (sudo usermod -aG docker \$USER) and log in again, or run this script with sudo."
fi

# --- Port ------------------------------------------------------------------
port=$(ask "Which port should Salto use?" "${SALTO_PORT:-3000}")
case $port in
  ''|*[!0-9]*) fail "'$port' is not a valid port number." ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  fail "'$port' is not a valid port number (1–65535)."
fi

# --- .env with SESSION_SECRET ----------------------------------------------
generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

secret=''
if [ -f .env ]; then
  secret=$(sed -n 's/^SESSION_SECRET=//p' .env | head -n1)
fi
if [ -n "$secret" ]; then
  note "Keeping the existing SESSION_SECRET from .env (changing it would sign everyone out)."
else
  secret=$(generate_secret)
  note "Generated a new SESSION_SECRET."
fi

cat > .env <<EOF
# Salto configuration — created by install.sh. Do not commit or share this file.
SALTO_PORT=$port
SESSION_SECRET=$secret
EOF
chmod 600 .env
note "Wrote .env (port $port)."

# --- Compose file ----------------------------------------------------------
if [ -f docker-compose.yml ]; then
  note "Keeping the existing docker-compose.yml."
elif curl -fsSL "$REPO_RAW/docker-compose.yml" -o docker-compose.yml 2>/dev/null; then
  note "Downloaded docker-compose.yml."
else
  warn "Could not download docker-compose.yml — creating it locally instead."
  cat > docker-compose.yml <<'EOF'
# Salto — user-facing deployment. Update with:
#   docker compose pull && docker compose up -d
name: salto

services:
  salto:
    image: ghcr.io/stevy2191/salto:latest
    restart: unless-stopped
    ports:
      - "${SALTO_PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
      - DATA_DIR=/data
      - SESSION_SECRET=${SESSION_SECRET:-}
    volumes:
      - salto-data:/data

volumes:
  salto-data:
    name: salto-data
EOF
fi

# --- Pull and start --------------------------------------------------------
bold "Pulling the Salto image…"
if ! "${COMPOSE[@]}" pull; then
  warn "Pull failed (offline, or the image isn't published yet). Trying to start anyway."
fi

bold "Starting Salto…"
"${COMPOSE[@]}" up -d

bold "Salto is running! 🤸"
note "Open http://localhost:$port (or http://<this-server's-address>:$port)"
note "to create your admin account and set up your gym."
echo
note "Update later with:    ${COMPOSE[*]} pull && ${COMPOSE[*]} up -d"
note "Uninstall with:       bash uninstall.sh  (from this directory)"
