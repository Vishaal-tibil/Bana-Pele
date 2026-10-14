# Bana Pele ECD Network: working model

A private Beckn network for UC1 (registration help), built from separate nodes
that talk only through the official Beckn ONIX adapter. It does not touch the
current naledi-stack: everything lives in this folder, and the current deploy
workflow does not watch it.

```
Journey node (BAP)               WeHelp node (BPP)              GROW node (BPP)
 Naledi app, monitor              dashboard                      dashboard
 app :7100                        app :7201                      app :7202
 ONIX adapter :8100  <-- signed Beckn -->  ONIX :8201  <-->  ONIX :8202
 Redis                            Redis                          Redis
                 \                    |                    /
                  ecd-registry :3030  (our private registry: id, url, public keys)
```

- **ONIX adapters** sign every message, check every signature against our
  registry, validate the Beckn v2.0.0 schema and route. Apps never call each
  other; each app talks only to its own adapter (caller out, webhook in).
- **ecd-registry** replaces DeDi for a private network. ONIX's `registry`
  plugin asks it for a sender's key (`POST /lookup`); apps ask it which
  providers are live (`GET /subscribers`).
- **Provider rules and data** come from Elevate: each provider node reads its
  org profile from `seed/elevate/org_profiles.json` and decides with Elevate's
  own matching rule (capability, communities, tier).

## Run it

With Docker (laptop):

```bash
cd ecd-network
./start-docker.sh --fresh
# Naledi app  http://localhost:7100      monitor  http://localhost:7100/monitor
# WeHelp      http://localhost:7201      GROW     http://localhost:7202
./stop-docker.sh
```

Without Docker (needs `redis-server` and an ONIX binary + plugins built from
github.com/beckn/beckn-onix with one Go version):

```bash
ONIX_BIN=/path/to/server ONIX_PLUGINS=/path/to/plugins ./start-local.sh --fresh
./stop-local.sh
```

Keys are made on first start (`.keys/`, never committed). Adapter configs are
generated into `.generated/` (they contain the private keys, never committed).

## Test it

```bash
./start-docker.sh --fresh --test
ECD_MODE=docker ECD_REGISTRY_CACHE_TTL=3s node test/e2e.js
# or, local processes:
ONIX_BIN=... ONIX_PLUGINS=... ./start-local.sh --fresh --test
ONIX_BIN=... ONIX_PLUGINS=... ECD_REGISTRY_CACHE_TTL=3s node test/e2e.js
```

`--test` shows message bodies in the message APIs (the tests read them) and
caches registry lookups for 3 s instead of 60 s. The end-to-end test runs:

| Part | What it proves |
| --- | --- |
| `test/network-core.js` | Real signed messages are ACKed; forged, unsigned, altered, expired, unknown-sender and schema-breaking messages are refused by ONIX |
| `test/provider.js` | WeHelp and GROW answer (or stay silent) by their own rules; select, init, confirm, status, staff accept/complete all flow |
| UC1 via the Journey API | Register, ask, every provider asked, ranked answers, consent, booking, accepted with a coach, completed |
| Consent | Only the chosen provider gets her details, only the ticked ones; discover carries none |
| Replay, decline | A replayed message is processed once; a decline reaches Naledi |
| New node | SmartStart joins with `tools/new-node.js`, answers, needs no change to any other node; paused, it is refused |

`test/browser/uc1.js` clicks through the real pages (Playwright) and saves screenshots.

## Add a provider

```bash
node tools/new-node.js smartstart --elevate provider-smartstart \
  --offer "Business support for early learning programmes" --terms "Free"
./start-node.sh smartstart        # local
./start-docker.sh                 # Docker: brings up the new node only
```

The tool writes `config/nodes/smartstart.json`, makes its keys and ONIX
config, and adds its record to the registry. To pause a node, add
`"status": "paused"` to its node file and run `node tools/configure.js`.

## Elevate data

`seed/elevate/` holds Elevate's demo data without passwords, tokens or ids:
org profiles, people, consent categories and need types. To refresh the org
profiles from a live export: `node tools/import-elevate.js elevate-data/coordination-org_profiles.csv`.

## Files

| Path | What it is |
| --- | --- |
| `config/network.json`, `config/nodes/*.json` | Network id and one settings file per node |
| `registry/server.js` | ecd-registry |
| `nodes/journey/` | Journey node app: Naledi app, consent, ranking, monitor |
| `nodes/provider/` | Provider node app, run once per provider |
| `lib/` | Addresses, Beckn message builders, matching rule, shared app kit |
| `tools/configure.js` | Keys, ONIX configs, registry file, Docker Compose file |
| `tools/new-node.js`, `tools/import-elevate.js` | Add a provider; refresh Elevate data |
| `test/` | Network-core, provider, end-to-end and browser tests |

## Limits of the model

Naledi and provider staff have no real login (a device session for Naledi,
none for staff). Data is a JSON file per node. Locally the registry and
adapters talk plain HTTP. Azure deployment is the next phase.
