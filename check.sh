#!/usr/bin/env bash
# Checks that everything needed for the connection works: our side, the
# partner's two endpoints (if connected), and a real round trip through both
# Beckn adapters. Exit code 0 = all good.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
set +e

KEY="$(env_get API_KEY)"
MATCH_URL="$(env_get MATCH_URL)"
EVENTS_URL="$(env_get EVENTS_URL)"
FAILS=0
fail() { bad "$*"; FAILS=$((FAILS+1)); }

say "== Our side"
[ -n "$KEY" ] || fail "no API key found -- run ./setup.sh"
H="$(curl -fsS -m 5 "$EDGE_LOCAL/v1/health" 2>/dev/null)" && ok "API answers: $H" || fail "API not reachable at $EDGE_LOCAL (run ./start.sh)"
for c in onix-bap onix-bpp sandbox-bap sandbox-bpp naledi-edge; do
  s="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)"
  [ "$s" = running ] && ok "$c is running" || fail "$c is $s"
done
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$EDGE_LOCAL/v1/search")"
[ "$code" = 401 ] && ok "calls without the key are refused (401)" || fail "expected 401 without a key, got $code"
PUB="$(env_get PUBLIC_URL)"
if [ -n "$PUB" ]; then
  curl -fsS -m 8 "$PUB/v1/health" >/dev/null 2>&1 && ok "public URL answers: $PUB" || warn "public URL $PUB does not answer (restart with ./start.sh --tunnel)"
fi

if [ -n "$MATCH_URL" ] && [ -n "$EVENTS_URL" ]; then
  BASE="${EVENTS_URL%/network/events}"
  say ""
  say "== The partner's backend ($BASE)"
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/network/health")"
  [ "$code" = 200 ] && ok "GET /network/health -> 200" || fail "GET /network/health -> $code (is it deployed, and is the address right?)"
  R="$(curl -s -m 10 -H "X-Api-Key: $KEY" "$MATCH_URL?needType=registration&region=Alexandra&practitionerId=prac_check&tier=Pre-Bronze&children=28")"
  echo "$R" | grep -q '"matches"' && ok "GET /network/match answers: $(echo "$R" | cut -c1-150)" || fail "GET /network/match did not return {\"matches\":[...]} -> $(echo "$R" | cut -c1-150)"
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d "{\"eventId\":\"check-$(date +%s)\",\"event\":\"ping\"}" "$EVENTS_URL")"
  case "$code" in 2*) ok "POST /network/events accepts an event ($code)";; *) fail "POST /network/events -> $code (must answer 2xx)";; esac
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "X-Api-Key: wrong" -H 'Content-Type: application/json' -d '{"eventId":"x","event":"ping"}' "$EVENTS_URL")"
  [ "$code" = 401 ] && ok "their endpoint refuses a wrong key (401)" || warn "their /network/events did not refuse a wrong key (got $code) -- it should check X-Api-Key"
else
  say ""
  say "  (no partner connected: using the built-in providers. Connect one with ./connect.sh <address>)"
fi

say ""
say "== A real search through both Beckn adapters"
R="$(curl -s -m 15 -X POST "$EDGE_LOCAL/v1/search" -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d '{"practitionerId":"prac_selfcheck","needType":"registration","region":"Alexandra","tier":"Pre-Bronze","children":28}')"
TX="$(echo "$R" | sed -n 's/.*"transactionId":"\([^"]*\)".*/\1/p')"
if [ -z "$TX" ]; then
  fail "the search was refused: $(echo "$R" | cut -c1-200)"
else
  S=""; N=""
  for i in $(seq 1 30); do
    J="$(curl -s -m 5 "$EDGE_LOCAL/v1/status/$TX" -H "X-Api-Key: $KEY")"
    S="$(echo "$J" | sed -n 's/.*"status":"\([a-z_]*\)","order".*/\1/p')"
    N="$(echo "$J" | sed -n 's/.*"resultsCount":\([0-9]*\).*/\1/p')"
    [ "$S" = results_ready ] && break
    sleep 0.5
  done
  if [ "$S" = results_ready ]; then
    ok "the search went out through onix-bap, came back through onix-bpp ($N provider(s) matched)"
    if [ "${N:-0}" = 0 ] && [ -n "$MATCH_URL" ]; then warn "no match for the sample practitioner (Alexandra, Pre-Bronze, 28 children) -- check the partner's match rules"; fi
  else
    fail "no answer from the network for the test search (status: ${S:-none}); see: docker logs onix-bap"
  fi
fi

say ""
if [ "$FAILS" = 0 ]; then say "All checks passed."; else say "$FAILS check(s) failed."; exit 1; fi
