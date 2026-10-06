#!/usr/bin/env bash
# try-all-apis.sh -- calls every /v1 API in flow order and shows the answers.
#
#   bash try-all-apis.sh
#
# Needs the stack running (bash start.sh). Uses the local edge and the key
# from install/.env unless BASE / API_KEY are set.

BASE="${BASE:-http://localhost:3010}"
API_KEY="${API_KEY:-$(grep '^API_KEY=' ~/starter-kit/generic-devkit/install/.env 2>/dev/null | cut -d= -f2)}"
API_KEY="${API_KEY:-demo-key-change-me}"
P="prac_check_$(date +%s)"   # a fresh practitioner each run
OK=0; BAD=0

show() { # show "title" expected-code actual-code body
  local mark="PASS"; if [ "$2" != "$3" ]; then mark="FAIL"; BAD=$((BAD+1)); else OK=$((OK+1)); fi
  printf '\n[%s] %s  (HTTP %s, expected %s)\n' "$mark" "$1" "$3" "$2"
  printf '%s\n' "$4" | head -c 600; echo
}
call() { # call METHOD PATH [JSON]  -> sets CODE and BODY
  local out
  if [ -n "$3" ]; then
    out=$(curl -s -w '\n%{http_code}' -X "$1" "$BASE$2" -H "X-Api-Key: $API_KEY" -H 'Content-Type: application/json' -d "$3")
  else
    out=$(curl -s -w '\n%{http_code}' -X "$1" "$BASE$2" -H "X-Api-Key: $API_KEY")
  fi
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
field() { printf '%s' "$BODY" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }
wait_status() { # wait_status TX WANT
  for i in $(seq 1 20); do call GET "/v1/status/$1"; [ "$(field status)" = "$2" ] && return 0; sleep 0.5; done; return 1
}

echo "Base URL: $BASE"
echo "Practitioner: $P"

# Health -- no key needed
out=$(curl -s -w '\n%{http_code}' "$BASE/v1/health"); show "Health: GET /v1/health (no key)" 200 "${out##*$'\n'}" "${out%$'\n'*}"

# Security check: no key -> 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/search" -H 'Content-Type: application/json' -d '{}')
show "Security: POST /v1/search without key is refused" 401 "$code" ""

# 1. Search
call POST /v1/search "{\"practitionerId\":\"$P\",\"needType\":\"registration\",\"region\":\"Alexandra\",\"tier\":\"Pre-Bronze\",\"children\":28}"
TX=$(field transactionId); show "1. Search: POST /v1/search" 202 "$CODE" "$BODY"
[ -z "$TX" ] && { echo "No transactionId -- stopping."; exit 1; }
wait_status "$TX" results_ready

# 2. Results
call GET "/v1/results/$TX"; show "2. Results: GET /v1/results/{id}" 200 "$CODE" "$BODY"
PROVIDER=provider-wehelp

# 3. Offer (optional step)
call POST /v1/provider/offer "{\"transactionId\":\"$TX\",\"providerId\":\"$PROVIDER\",\"offerId\":\"off_$P\",\"title\":\"Registration support\",\"area\":\"Alexandra\"}"
show "3. Offer: POST /v1/provider/offer" 200 "$CODE" "$BODY"

# 4. Select
call POST /v1/select "{\"transactionId\":\"$TX\",\"practitionerId\":\"$P\",\"needType\":\"registration\",\"providerId\":\"$PROVIDER\"}"
show "4. Select: POST /v1/select" 202 "$CODE" "$BODY"
wait_status "$TX" pending

# 5. Decision
call POST /v1/provider/decision "{\"transactionId\":\"$TX\",\"decision\":\"accept\",\"coachId\":\"coach_thabo_nkosi\"}"
show "5. Decision: POST /v1/provider/decision" 200 "$CODE" "$BODY"
wait_status "$TX" reserved

# 6. Confirm
call POST /v1/confirm "{\"transactionId\":\"$TX\",\"note\":\"Documents submitted\"}"
show "6. Confirm: POST /v1/confirm" 202 "$CODE" "$BODY"
sleep 1

# 7. Complete
call POST /v1/provider/complete "{\"transactionId\":\"$TX\"}"
show "7. Complete: POST /v1/provider/complete" 200 "$CODE" "$BODY"
wait_status "$TX" fulfilled

# Tracking
call GET "/v1/status/$TX"; show "Tracking: GET /v1/status/{id} (should say fulfilled)" 200 "$CODE" "$BODY"
[ "$(field status)" = "fulfilled" ] && { OK=$((OK+1)); echo "[PASS] final status is fulfilled"; } || { BAD=$((BAD+1)); echo "[FAIL] final status is $(field status), expected fulfilled"; }
call GET "/v1/log/$TX"
n=$(printf '%s' "$BODY" | grep -o '"event":' | wc -l)
show "Tracking: GET /v1/log/{id} ($n log entries)" 200 "$CODE" "$(printf '%s' "$BODY" | head -c 300)..."

echo
echo "=============================="
echo " $OK passed, $BAD failed"
echo " transactionId: $TX"
echo "=============================="
[ "$BAD" = 0 ]
