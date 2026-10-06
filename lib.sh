#!/usr/bin/env bash
# Shared helpers for setup.sh / start.sh / stop.sh / connect.sh / check.sh.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTER_KIT_DIR="${STARTER_KIT_DIR:-$HOME/starter-kit}"
INSTALL_DIR="$STARTER_KIT_DIR/generic-devkit/install"
CONFIG_DIR="$STARTER_KIT_DIR/generic-devkit/config"
ENV_FILE="$INSTALL_DIR/.env"
EDGE_LOCAL="${EDGE_LOCAL:-http://localhost:3010}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
die()  { bad "$*"; exit 1; }

# docker compose with both files, run from the install folder.
compose() { (cd "$INSTALL_DIR" && docker compose -f docker-compose-generic.yml -f docker-compose.override-naledi.yml "$@"); }

# Settings live in install/.env (docker compose reads it automatically).
env_get() {
  if [ -f "$ENV_FILE" ]; then grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; fi
}
env_set() { # env_set KEY VALUE   (VALUE may contain / : ? = &)
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ]; then grep -v -E "^${key}=" "$ENV_FILE" > "$tmp" || true; fi
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

wait_for_api() { # wait_for_api [seconds]
  local n="${1:-60}" i
  for i in $(seq 1 "$n"); do
    curl -fsS "$EDGE_LOCAL/v1/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# The two Beckn adapters take a few seconds after the apps to start listening.
# Wait for both (judged from their own logs, since the last time they started).
# Note: count with `grep -c` (reads everything) rather than `grep -q`; with
# `set -o pipefail`, grep -q quitting early would make a long log look like a failure.
wait_for_adapters() { # wait_for_adapters [seconds]
  local n="${1:-90}" i s1 s2 c1 c2
  for i in $(seq 1 "$n"); do
    s1="$(docker inspect -f '{{.State.StartedAt}}' onix-bap 2>/dev/null || true)"
    s2="$(docker inspect -f '{{.State.StartedAt}}' onix-bpp 2>/dev/null || true)"
    if [ -n "$s1" ] && [ -n "$s2" ]; then
      c1="$(docker logs --since "$s1" onix-bap 2>&1 | grep -c 'Server listening on :8081' || true)"
      c2="$(docker logs --since "$s2" onix-bpp 2>&1 | grep -c 'Server listening on :8082' || true)"
      if [ "${c1:-0}" -gt 0 ] && [ "${c2:-0}" -gt 0 ]; then return 0; fi
    fi
    sleep 1
  done
  return 1
}
