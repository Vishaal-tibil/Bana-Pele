#!/usr/bin/env bash
# start-node.sh -- starts one node (its Redis, ONIX adapter and app) as local
# processes, without touching the others. start-local.sh uses it for every
# node; use it alone after tools/new-node.js to bring a new node up.
#
#   ONIX_BIN=... ONIX_PLUGINS=... ./start-node.sh <node-id>
set -euo pipefail
# Resolve ONIX paths before changing directory, so relative paths work too.
absdir() { (cd "$(dirname "$1")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename "$1")"); }
[ -n "${ONIX_BIN:-}" ] && ONIX_BIN=$(absdir "$ONIX_BIN") && export ONIX_BIN
[ -n "${ONIX_PLUGINS:-}" ] && ONIX_PLUGINS=$(absdir "$ONIX_PLUGINS") && export ONIX_PLUGINS
cd "$(dirname "$0")"
: "${ONIX_BIN:?set ONIX_BIN}"; : "${ONIX_PLUGINS:?set ONIX_PLUGINS}"
id=${1:?node id}; f=config/nodes/$id.json
[ -f "$f" ] || { echo "no $f"; exit 1; }
RUN=.run; mkdir -p "$RUN" data
[ -f "$RUN/env" ] && . "$RUN/env"
[ -f ".generated/onix/$id/adapter.yaml" ] || { echo "run node tools/configure.js first"; exit 1; }

a=$(node -p "require('./$f').ports.app"); o=$(node -p "require('./$f').ports.onix")
# Refuse to start twice: a second copy would fail on the ports, and its pid
# files would replace the running copy's.
for port in "$a" "$o"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/"; then echo "$id is already running (port $port answers); ./stop-local.sh first"; exit 1; fi
done
start() { local name=$1; shift; nohup "$@" > "$RUN/$name.log" 2>&1 & echo $! > "$RUN/$name.pid"; }
role=$(node -p "require('./$f').role"); rport=$(node -p "require('./$f').ports.redis")
redis-server --port "$rport" --save "" --appendonly no --daemonize yes \
  --pidfile "$PWD/$RUN/redis-$id.pid" --logfile "$PWD/$RUN/redis-$id.log"
start "onix-$id" "$ONIX_BIN" --config="$PWD/.generated/onix/$id/adapter.yaml"
if [ "$role" = "BAP" ]; then app=nodes/journey/server.js; else app=nodes/provider/server.js; fi
NODE_FILE="$PWD/$f" start "app-$id" node "$app"

for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$a/health" >/dev/null && curl -s -o /dev/null "http://127.0.0.1:$o/" && { echo "  $id up: app :$a, adapter :$o"; exit 0; }
  sleep 0.5
done
echo "$id did not come up; see $RUN/onix-$id.log and $RUN/app-$id.log"; exit 1
