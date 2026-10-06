#!/usr/bin/env bash
# apply-node-identity.sh -- puts our own node identity into the ONIX adapter
# configs, replacing the starter kit's shared bap.example.com / bpp.example.com.
#
#   bash tools/apply-node-identity.sh ~/starter-kit/generic-devkit/config identity/<bap>.env identity/<bpp>.env
#
# Edits generic-bap.yaml with the BAP identity and generic-bpp.yaml with the BPP
# identity (every keyManager block in the file), keeping a .orig copy the first
# time. Then set BAP_ID / BPP_ID (and on Azure BAP_URI / BPP_URI) in install/.env
# and restart. The adapters only accept each other's messages once both
# identities are registered in DeDi (tools/gen-node-identity.sh writes the
# public part to register).

set -euo pipefail
[ $# -eq 3 ] || { echo "usage: $0 <config-dir> <bap.env> <bpp.env>"; exit 1; }
CFG="$1"

apply() { # apply <yaml> <env>
  local y="$CFG/$1" env="$2"
  [ -f "$y" ] || { echo "missing $y"; exit 1; }
  # shellcheck disable=SC1090
  ( set -a; . "$env"; set +a
    [ -n "${SUBSCRIBER_ID:-}" ] && [ -n "${SIGNING_PRIVATE_KEY:-}" ] || { echo "bad identity file $env"; exit 1; }
    [ -f "$y.orig" ] || cp "$y" "$y.orig"
    sed -i -E \
      -e "s#^([[:space:]]*subscriberId:).*#\1 ${SUBSCRIBER_ID}#" \
      -e "s#^([[:space:]]*keyId:).*#\1 ${KEY_ID}#" \
      -e "s#^([[:space:]]*signingPrivateKey:).*#\1 ${SIGNING_PRIVATE_KEY}#" \
      -e "s#^([[:space:]]*signingPublicKey:).*#\1 ${SIGNING_PUBLIC_KEY}#" \
      -e "s#^([[:space:]]*encrPrivateKey:).*#\1 ${ENCR_PRIVATE_KEY}#" \
      -e "s#^([[:space:]]*encrPublicKey:).*#\1 ${ENCR_PUBLIC_KEY}#" \
      "$y"
    echo "$1 -> $SUBSCRIBER_ID ($(grep -c 'subscriberId:' "$y") keyManager blocks)" )
}
apply generic-bap.yaml "$2"
apply generic-bpp.yaml "$3"
echo
echo "Now in install/.env:  BAP_ID=<bap id>  BPP_ID=<bpp id>   then: bash stop.sh && bash start.sh"
echo "To undo: copy the .orig files back."
