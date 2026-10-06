#!/usr/bin/env bash
# Points our network at the partner's deployed backend, then checks the link.
#
#   ./connect.sh https://their-backend.run.app/api/v1     connect (their /network/match and /network/events live under this address)
#   ./connect.sh --off                                    disconnect (back to the built-in providers)
#
# It saves the addresses in install/.env, restarts our two apps with them, and
# runs ./check.sh.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ -d "$INSTALL_DIR" ] || die "run ./setup.sh and ./start.sh first"
ARG="${1:-}"
[ -n "$ARG" ] || { sed -n '2,8p' "$0"; exit 1; }

if [ "$ARG" = "--off" ]; then
  env_set MATCH_URL ""
  env_set EVENTS_URL ""
  say "== Disconnecting from the partner"
else
  BASE="${ARG%/}"
  case "$BASE" in http://*|https://*) ;; *) die "give the full address, for example https://their-backend.run.app/api/v1" ;; esac
  BASE="${BASE%/network/events}"; BASE="${BASE%/network/match}"; BASE="${BASE%/network}"
  env_set MATCH_URL "$BASE/network/match"
  env_set EVENTS_URL "$BASE/network/events"
  say "== Connecting to $BASE"
fi

# The config changed, so compose recreates the two apps (no rebuild needed).
compose up -d sandbox-bap sandbox-bpp >/dev/null 2>&1 || die "could not restart the apps (docker compose up failed)"
wait_for_api 60 || die "the API did not come back. Look at: docker logs sandbox-bap"
ok "apps restarted with the new setting"
say ""
bash "$HERE/check.sh"
