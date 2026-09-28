#!/usr/bin/env bash
# Starts the whole network: the Beckn adapters, our two apps and the edge.
#
#   ./start.sh                start it (local only)
#   ./start.sh --tunnel       also open a public https URL for the partner (no account needed)
#   ./start.sh --reference    also start the reference partner app and connect to it (for testing)
#   ./start.sh --mock         same, with the simpler stand-in partner (for tests/e2e.js --delegated)
#
# Safe to run again; it rebuilds and restarts only what changed.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TUNNEL=0; REFERENCE=0; MOCK=0
for a in "$@"; do
  case "$a" in
    --tunnel) TUNNEL=1 ;;
    --reference) REFERENCE=1 ;;
    --mock) MOCK=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown option: $a (try --help)" ;;
  esac
done

if [ ! -f "$INSTALL_DIR/docker-compose.override-naledi.yml" ] || [ -z "$(env_get API_KEY)" ]; then
  bash "$HERE/setup.sh"
else
  # keep the installed copy in step with this folder
  cp "$HERE/docker-compose.override-naledi.yml" "$HERE/edge.Caddyfile" "$INSTALL_DIR/"
  rm -rf "$INSTALL_DIR/our-backend-naledi" "$INSTALL_DIR/partner-kit"
  cp -r "$HERE/our-backend-naledi" "$INSTALL_DIR/our-backend-naledi"
  cp -r "$HERE/partner-kit" "$INSTALL_DIR/partner-kit"
  rm -rf "$INSTALL_DIR/partner-kit/node_modules"
fi

SERVICES="redis onix-bap onix-bpp beckn-router sandbox-bap sandbox-bpp edge"
[ "$TUNNEL" = 1 ] && SERVICES="$SERVICES tunnel"
if [ "$REFERENCE" = 1 ]; then
  SERVICES="$SERVICES ref-partner"
  export MATCH_URL="http://ref-partner:3004/api/v1/network/match"
  export EVENTS_URL="http://ref-partner:3004/api/v1/network/events"
fi
if [ "$MOCK" = 1 ]; then
  SERVICES="$SERVICES mock-mj"
  export MATCH_URL="http://mock-mj:3003/network/match"
  export EVENTS_URL="http://mock-mj:3003/network/events"
fi

say "== Starting the network"
compose up --build -d $SERVICES >/dev/null 2>&1 || { compose up --build -d $SERVICES; die "docker compose failed (output above)"; }
say "  waiting for the API ..."
wait_for_api 90 || die "the API did not come up. Look at: docker logs sandbox-bap"
ok "API is up"
say "  waiting for the Beckn adapters ..."
wait_for_adapters 90 || die "the Beckn adapters did not start listening. Look at: docker logs onix-bap  and  docker logs onix-bpp"
ok "both Beckn adapters are ready"

PUBLIC_URL=""
if [ "$TUNNEL" = 1 ]; then
  say "  opening the public URL ..."
  for i in $(seq 1 60); do
    PUBLIC_URL="$(docker logs naledi-tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)"
    [ -n "$PUBLIC_URL" ] && break
    sleep 1
  done
  if [ -z "$PUBLIC_URL" ]; then
    warn "no public URL yet -- see: docker logs naledi-tunnel  (some networks block the tunnel)"
  else
    for i in $(seq 1 40); do
      curl -fsS -m 5 "$PUBLIC_URL/v1/health" >/dev/null 2>&1 && { ok "public URL answers"; break; }
      sleep 2
    done
  fi
fi
env_set PUBLIC_URL "$PUBLIC_URL"

KEY="$(env_get API_KEY)"
say ""
say "================================================================"
say " The network is up."
say "   Local API      $EDGE_LOCAL          (this machine only)"
[ -n "$PUBLIC_URL" ] && say "   Public API     $PUBLIC_URL"
say "   API key        $KEY"
say "   Demo pages     http://localhost:3001/live   (built-in Naledi + provider screens)"
say ""
if [ -n "$PUBLIC_URL" ]; then
  say " Give the My Journey team, privately:  the Public API URL and the API key,"
  say " plus the partner-kit/ folder and PARTNER-CONTRACT.md."
  say " When their backend is deployed:       ./connect.sh https://<their-backend>/api/v1"
else
  say " For a public URL for the partner:     ./start.sh --tunnel"
  say " When their backend is deployed:       ./connect.sh https://<their-backend>/api/v1"
fi
say "================================================================"
