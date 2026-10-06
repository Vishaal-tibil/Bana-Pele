# Our own node identity (task 6.7)

Today both adapters sign with the starter kit's shared test identities
`bap.example.com` / `bpp.example.com` (same keys for everyone on the testnet).
To be a real participant we need our own subscriber ids and keys, registered in
DeDi so other nodes can check our signatures.

## What we need from others

| Item | From | Example |
|---|---|---|
| Two subscriber ids (domains we control) | us / SRE | `bap.naledi.<our-domain>`, `bpp.naledi.<our-domain>` |
| DeDi access: a namespace/account to publish our records, and the registry URL our adapters should look up | network operator (DeDi admin) | lookup: `GET {url}/lookup/{subscriber_id}/subscribers.beckn.one/{key_id}` |
| Membership of `beckn.one/testnet` for both ids | network operator | `network_memberships: ["beckn.one/testnet"]` |
| Public HTTPS receiver URLs (only when another node talks to us) | Azure (6.4) | `https://<app>/bap/receiver`, `https://<app>/bpp/receiver` |

## Steps

1. Make the keys (once; private keys stay on your machine and later in Key Vault):

   ```bash
   bash tools/gen-node-identity.sh bap.naledi.<domain> bpp.naledi.<domain>
   ```

   Writes `identity/<id>.env` (private, git-ignored) and
   `identity/<id>.public.json` (subscriber id, key id, Ed25519 signing public
   key, X25519 encryption public key).

2. Register the two `*.public.json` records in DeDi (needs the access above).

3. Put the identity into the adapter configs and our apps:

   ```bash
   bash tools/apply-node-identity.sh ~/starter-kit/generic-devkit/config \
        identity/bap.naledi.<domain>.env identity/bpp.naledi.<domain>.env
   # install/.env
   BAP_ID=bap.naledi.<domain>
   BPP_ID=bpp.naledi.<domain>
   ```

   If DeDi gave a registry URL, add `url: <it>` under each `dediregistry`
   `config:` in generic-bap.yaml and generic-bpp.yaml.

4. Restart (`bash stop.sh && bash start.sh`) and run `node tests/e2e.js` and
   `node tests/uc1.js`. Signature checks pass only after step 2, so do steps 2
   and 3 together; `.orig` copies let you roll back.

Never paste private keys in chat or commit them; rotate by generating a new key
id (the script dates it) and registering it before switching.
