#!/usr/bin/env bash
# Salto installer — sets up and starts Salto with Docker Compose, and leaves
# the install directory self-sufficient: install.sh, uninstall.sh,
# docker-compose.yml, .env, and MANAGE.md all live here afterwards.
#
#   curl -fsSL https://raw.githubusercontent.com/Stevy2191/salto/main/install.sh | bash
#
# Safe to re-run on an existing installation (repair/update mode): your .env
# and data are never clobbered — scripts and compose file are refreshed and
# the latest image is pulled.
#
# Interactive prompts read from the terminal even when piped from curl.
# Non-interactive use: preset answers via environment variables, e.g.
#   SALTO_PORT=8080 bash install.sh
set -euo pipefail

REPO_RAW="${SALTO_REPO_RAW:-https://raw.githubusercontent.com/Stevy2191/salto/main}"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)
fi

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

# fetch <name> <dest>: download from the repo, or copy from the directory
# this script runs from (repo checkout / previous install). Writes via a
# temp file + rename so a running script can safely replace itself.
fetch() {
  local name=$1 dest=$2
  if curl -fsSL "$REPO_RAW/$name" -o "$dest.tmp" 2>/dev/null; then
    mv "$dest.tmp" "$dest"
    return 0
  fi
  rm -f "$dest.tmp"
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$name" ]; then
    if [ "$SCRIPT_DIR/$name" -ef "$dest" ]; then
      return 0 # already the same file
    fi
    cp "$SCRIPT_DIR/$name" "$dest"
    return 0
  fi
  return 1
}

# ensure_env <key> <value>: set exactly one KEY=value line in .env without
# touching anything else in the file.
ensure_env() {
  local key=$1 value=$2
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
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

repair=false
if [ -f .env ]; then
  repair=true
  note "Existing installation found — repair/update mode (your .env and data are kept)."
fi

# --- Port ------------------------------------------------------------------
current_port=$({ sed -n 's/^SALTO_PORT=//p' .env 2>/dev/null || true; } | head -n1)
port=$(ask "Which port should Salto use?" "${SALTO_PORT:-${current_port:-3000}}")
case $port in
  ''|*[!0-9]*) fail "'$port' is not a valid port number." ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  fail "'$port' is not a valid port number (1–65535)."
fi

# --- .env (never clobbered — individual keys are ensured) -------------------
generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [ ! -f .env ]; then
  printf '# Salto configuration — created by install.sh. Do not commit or share this file.\n' > .env
fi
ensure_env SALTO_PORT "$port"
secret=$(sed -n 's/^SESSION_SECRET=//p' .env | head -n1)
if [ -n "$secret" ]; then
  note "Keeping the existing SESSION_SECRET (changing it would sign everyone out)."
else
  ensure_env SESSION_SECRET "$(generate_secret)"
  note "Generated a new SESSION_SECRET."
fi
chmod 600 .env
note "Configured .env (port $port)."

# --- Compose file (refreshed; a changed existing file is backed up) ---------
if fetch docker-compose.yml docker-compose.yml.new; then
  if [ -f docker-compose.yml ] && ! cmp -s docker-compose.yml docker-compose.yml.new; then
    cp docker-compose.yml docker-compose.yml.bak
    note "Updated docker-compose.yml (previous version saved as docker-compose.yml.bak)."
  fi
  mv docker-compose.yml.new docker-compose.yml
elif [ -f docker-compose.yml ]; then
  warn "Could not refresh docker-compose.yml — keeping the existing one."
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

# --- Management scripts land next to the compose file -----------------------
for script in install.sh uninstall.sh; do
  if fetch "$script" "$script"; then
    chmod +x "$script"
  else
    warn "Could not fetch $script — you can grab it later from the repo."
  fi
done

# --- MANAGE.md (managed file, rewritten on every run) ------------------------
cat > MANAGE.md <<'EOF'
# Managing Salto

Run everything from this directory.

| Task                         | Command                                        |
| ---------------------------- | ---------------------------------------------- |
| Update to the latest version | `docker compose pull && docker compose up -d`  |
| Stop                         | `docker compose stop`                          |
| Start                        | `docker compose up -d`                         |
| View logs                    | `docker compose logs -f`                       |
| Repair / re-install          | `./install.sh`                                 |
| Uninstall                    | `./uninstall.sh`                               |

Your data — schedules, groups, coaches, settings, the admin account — lives
in the Docker volume `salto-data`, not in this directory. Back it up with:

    docker run --rm -v salto-data:/data -v "$PWD":/backup alpine \
      tar czf /backup/salto-backup.tgz -C /data .

Restore by extracting the archive back into the volume:

    docker run --rm -v salto-data:/data -v "$PWD":/backup alpine \
      tar xzf /backup/salto-backup.tgz -C /data

Configuration lives in `.env` (port, session secret) — keep it private.

Note: one Salto installation per machine — the container and data volume
have fixed names, so a second install directory would adopt (not duplicate)
this one.
EOF
note "Wrote MANAGE.md."

# --- Pull and start ----------------------------------------------------------
bold "Pulling the Salto image…"
if ! "${COMPOSE[@]}" pull; then
  warn "Pull failed (offline, or the image isn't published yet). Trying to start anyway."
fi

bold "Starting Salto…"
"${COMPOSE[@]}" up -d

bold "Salto is running! 🤸"
note "Open http://localhost:$port (or http://<this-server's-address>:$port)"
if $repair; then
  note "Existing data and login are untouched."
else
  note "to create your admin account and set up your gym."
fi
echo
note "Manage Salto from this directory — see MANAGE.md."
note "Update:    ${COMPOSE[*]} pull && ${COMPOSE[*]} up -d"
note "Uninstall: ./uninstall.sh"
