#!/usr/bin/env bash
# start-docker.sh -- runs the whole ECD network in Docker on a laptop:
# ecd-registry + per node: Redis, the official ONIX adapter image, the app.
#
#   ./start-docker.sh [--fresh] [--test]
#
# --fresh  wipes app data      --test  message bodies visible, registry cache 3s (for test/e2e.js)
# Needs Docker with access to Docker Hub (fidedocker/onix-adapter, node:20-alpine, redis:7-alpine).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
export ECD_DEBUG_BODIES=0 ECD_ASK_TIMEOUT_MS=20000
for a in "$@"; do
  case "$a" in
    --fresh) rm -rf data/* && echo "data wiped" ;;
    --test) export ECD_DEBUG_BODIES=1 ECD_REGISTRY_CACHE_TTL=3s ECD_ASK_TIMEOUT_MS=4000; echo "test mode" ;;
  esac
done
node tools/configure.js --mode docker
docker compose -f .generated/docker-compose.yml up -d --remove-orphans
for i in $(seq 1 120); do
  ok=1
  for f in config/nodes/*.json; do
    a=$(node -p "require('./$f').ports.app"); o=$(node -p "require('./$f').ports.onix")
    curl -sf "http://127.0.0.1:$a/health" >/dev/null || ok=0
    curl -s -o /dev/null "http://127.0.0.1:$o/" || ok=0
  done
  curl -sf http://127.0.0.1:3030/health >/dev/null || ok=0
  [ $ok = 1 ] && break; sleep 1
done
[ $ok = 1 ] || { echo "not everything came up: docker compose -f .generated/docker-compose.yml logs"; exit 1; }
echo "ECD network up (Docker):"
for f in config/nodes/*.json; do node -e "const n=require('./$f');console.log('  '+n.name.padEnd(18)+' http://localhost:'+n.ports.app+'   adapter :'+n.ports.onix)"; done
echo "  monitor            http://localhost:7100/monitor"
