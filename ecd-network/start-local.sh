#!/usr/bin/env bash
# start-local.sh -- runs the whole ECD network as plain processes on this machine
# (no Docker): ecd-registry, one Redis + one ONIX adapter + one app per node.
# For a laptop with Docker, use docker-compose.yml instead (same configs, mode docker).
#
#   ONIX_BIN=/path/to/onix/server ONIX_PLUGINS=/path/to/plugins ./start-local.sh [--fresh] [--test]
#
# Needs: node 18+, redis-server, and an ONIX adapter binary + plugins built from
# github.com/beckn/beckn-onix (same Go version for both). Logs and pids: .run/
set -euo pipefail
# Resolve ONIX paths before changing directory, so relative paths work too.
absdir() { (cd "$(dirname "$1")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename "$1")"); }
[ -n "${ONIX_BIN:-}" ] && ONIX_BIN=$(absdir "$ONIX_BIN") && export ONIX_BIN
[ -n "${ONIX_PLUGINS:-}" ] && ONIX_PLUGINS=$(absdir "$ONIX_PLUGINS") && export ONIX_PLUGINS
cd "$(dirname "$0")"
: "${ONIX_BIN:?set ONIX_BIN to the ONIX adapter binary}"
: "${ONIX_PLUGINS:?set ONIX_PLUGINS to the ONIX plugins directory}"
RUN=.run; mkdir -p "$RUN" data

TEST=0
for a in "$@"; do
  case "$a" in
    --fresh) rm -rf data/* && echo "data wiped" ;;
    --test) TEST=1; export ECD_REGISTRY_CACHE_TTL=3s; echo "test mode: message bodies visible, registry cache 3s" ;;
  esac
done
./stop-local.sh >/dev/null 2>&1 || true
# Settings every process of this run shares (start-node.sh reads them too).
echo "export ECD_DEBUG_BODIES=$TEST" > "$RUN/env"
[ "$TEST" = 1 ] && echo "export ECD_ASK_TIMEOUT_MS=4000" >> "$RUN/env"

ONIX_PLUGINS="$ONIX_PLUGINS" node tools/configure.js --mode local

RPORT=$(node -p "require('./config/network.json').registryPort")
nohup env PORT="$RPORT" REGISTRY_FILE="$PWD/.generated/registry.json" node registry/server.js > "$RUN/registry.log" 2>&1 &
echo $! > "$RUN/registry.pid"
pids=()
for f in config/nodes/*.json; do ./start-node.sh "$(basename "$f" .json)" >/dev/null & pids+=($!); done
for p in "${pids[@]}"; do wait "$p" || true; done

# Wait until every adapter and app answers.
for i in $(seq 1 40); do
  ok=1
  for f in config/nodes/*.json; do
    a=$(node -p "require('./$f').ports.app"); o=$(node -p "require('./$f').ports.onix")
    curl -sf "http://127.0.0.1:$a/health" >/dev/null || ok=0
    curl -s -o /dev/null "http://127.0.0.1:$o/" || ok=0
  done
  curl -sf "http://127.0.0.1:$RPORT/health" >/dev/null || ok=0
  [ $ok = 1 ] && break; sleep 0.5
done
[ $ok = 1 ] || { echo "not everything came up; see $RUN/*.log"; exit 1; }
echo "ECD network up:"
for f in config/nodes/*.json; do node -e "const n=require('./$f');console.log('  '+n.name.padEnd(18)+' http://localhost:'+n.ports.app+'   adapter :'+n.ports.onix)"; done
echo "  monitor            http://localhost:$(node -p "require('./config/nodes/journey.json').ports.app")/monitor"
echo "  registry           http://localhost:$RPORT/subscribers"
