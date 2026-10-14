#!/usr/bin/env bash
# stop-local.sh -- stops what start-local.sh / start-node.sh started, by pid
# file, and only if that pid is still one of ours (pids are reused after a reboot).
cd "$(dirname "$0")"
for p in .run/*.pid; do
  [ -f "$p" ] || continue
  pid=$(cat "$p")
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *onix*|*node*registry/server.js*|*node*nodes/*|*redis-server*) kill "$pid" 2>/dev/null || true ;;
  esac
  rm -f "$p"
done
echo "stopped"
