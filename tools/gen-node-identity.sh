#!/usr/bin/env bash
# gen-node-identity.sh -- makes our own Beckn node identity (task 6.7).
#
#   bash tools/gen-node-identity.sh bap.naledi.example.org bpp.naledi.example.org
#
# For each subscriber id it creates an Ed25519 signing key pair and an X25519
# encryption key pair (raw 32-byte keys, base64) and writes:
#   identity/<id>.env          private + public keys  -> keep secret, never commit
#   identity/<id>.public.json  public part            -> what goes into DeDi
# Run it once; re-running for an existing id refuses to overwrite.

set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <bap-subscriber-id> [<bpp-subscriber-id>]"; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed"; exit 1; }
OUT="${OUT:-identity}"; mkdir -p "$OUT"; chmod 700 "$OUT"
DAY="$(date +%Y%m%d)"

raw() { tail -c 32 | base64 | tr -d '\n'; }   # last 32 bytes of the DER = the raw key

for SID in "$@"; do
  [ -e "$OUT/$SID.env" ] && { echo "skip $SID: $OUT/$SID.env already exists"; continue; }
  KID="${SID}-k1-${DAY}"
  s=$(openssl genpkey -algorithm Ed25519)
  e=$(openssl genpkey -algorithm X25519)
  SPRIV=$(printf '%s\n' "$s" | openssl pkey -outform DER | raw)
  SPUB=$(printf '%s\n' "$s" | openssl pkey -pubout -outform DER | raw)
  EPRIV=$(printf '%s\n' "$e" | openssl pkey -outform DER | raw)
  EPUB=$(printf '%s\n' "$e" | openssl pkey -pubout -outform DER | raw)

  umask 077
  cat > "$OUT/$SID.env" <<E
SUBSCRIBER_ID=$SID
KEY_ID=$KID
SIGNING_PRIVATE_KEY=$SPRIV
SIGNING_PUBLIC_KEY=$SPUB
ENCR_PRIVATE_KEY=$EPRIV
ENCR_PUBLIC_KEY=$EPUB
E
  umask 022
  cat > "$OUT/$SID.public.json" <<E
{
  "subscriber_id": "$SID",
  "key_id": "$KID",
  "signing_public_key": "$SPUB",
  "encr_public_key": "$EPUB",
  "network_memberships": ["beckn.one/testnet"]
}
E
  echo "made $SID  (key id $KID)"
done
echo
echo "Public parts for DeDi: $OUT/*.public.json"
echo "Put them into the adapter configs: bash tools/apply-node-identity.sh <config dir> $OUT/<bap>.env $OUT/<bpp>.env"
echo "Private keys: $OUT/*.env  -- keep out of git and chat; put them in Key Vault."
