#!/usr/bin/env bash
# Salto uninstaller — stops and removes the Salto stack. Asks separately
# whether to delete the data volume.
#
# Run from the directory containing your docker-compose.yml.
# Non-interactive use: SALTO_DELETE_DATA=yes bash uninstall.sh
set -euo pipefail

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
note()  { printf '  %s\n' "$*"; }
warn()  { printf '\033[33m! %s\033[0m\n' "$*"; }
fail()  { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }

# Stdout carries only the answer — callers capture it with $(ask …).
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

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "Docker Compose not found — nothing to uninstall with."
fi

[ -f docker-compose.yml ] || fail "No docker-compose.yml here. Run this script from your Salto install directory."

bold "Stopping and removing the Salto stack…"
"${COMPOSE[@]}" down
note "Containers removed. Your data volume and .env are still on disk."

echo
warn "Deleting the data volume PERMANENTLY erases all schedules, sessions,"
warn "groups, coaches, events, settings, and the admin account."
answer=$(ask "Also delete the data volume 'salto-data'? Type 'yes' to delete" "${SALTO_DELETE_DATA:-no}")

if [ "$answer" = "yes" ]; then
  if docker volume rm salto-data >/dev/null 2>&1; then
    note "Data volume deleted."
  else
    warn "Could not delete the volume 'salto-data' (already gone?)."
  fi
else
  note "Keeping the data volume. Reinstalling later will pick your data back up."
fi

bold "Salto has been uninstalled."
note "Leftovers you may remove yourself: this directory (.env, docker-compose.yml,"
note "MANAGE.md, the scripts) and the image (docker image rm ghcr.io/stevy2191/salto:latest)."
