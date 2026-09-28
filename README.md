# Naledi Network

A **real Beckn network** that runs on one machine, and a way to **connect an
outside backend to it** (the My Journey demo server) with a few commands.

- "Real" means the official Beckn adapters (ONIX) sit in the middle: every
  message between the two sides is signed, checked against the official schema,
  and routed by them. Nothing is simulated in one process.
- "Connect" means: the outside backend calls a small REST API on our side, and
  our side calls two endpoints on theirs. The outside team never has to learn
  Beckn.

If you only want to run it, jump to [Quick start](#quick-start). If you want to
understand it first, read on.

---

## What this demonstrates

The story is Use Case 1, *"A Connected NGO Support Network for Every Naledi"*:

1. **Naledi**, an early-childhood practitioner in Alexandra, signs up.
2. The network tells **WeHelp**, an NGO whose service area, support types and
   eligibility match, that a relevant new practitioner has joined.
3. WeHelp offers registration support. Naledi sees the offer and accepts it.
4. WeHelp assigns a coach. The need is **reserved**, and nobody else can take it.
5. The support is delivered and marked **fulfilled**.

Every step that crosses between the two sides is a real Beckn message. A person
on the provider side approves each change; nothing moves by itself.

### A note on "who starts"

Beckn discovery starts from the person who needs help. The story above starts
from the NGO ("WeHelp offers"). We reconcile the two like this: Naledi's signup
puts her need on the network as her own **standing search**, and WeHelp's offer
is a **later, second answer to that same search**. So the protocol stays
seeker-first, while the screens show a provider-first story. It works on the
real adapters (verified, including offers sent well after the search's 30-second
time-to-live). Details in [docs/INTEGRATION.md](docs/INTEGRATION.md).

---

## How it fits together

```
 Partner backend (for example My Journey, on Cloud Run)
        |  calls our REST API  (X-Api-Key)          ^  we call their two endpoints
        v                                           |  (/network/match, /network/events)
 +------------------ public URL (tunnel) -----------+------------------+
 |  edge :3010   passes /v1/* only, everything else is a 404           |
 +----------------------------------+-----------------------------------+
                                    v
   sandbox-bap :3001                         sandbox-bpp :3002
   BUYER app (Naledi's side)                 PROVIDER app (WeHelp's side)
   REST API, one record per search           asks the partner "who matches?",
   events to the partner                     blocks double reservations, applies decisions
        |                                           ^
        v            real Beckn messages            |
   onix-bap :8081  <==== signed, schema-checked ====>  onix-bpp :8082
        \____________________  redis :6379  _________________/
```

| Piece | Port | Whose | What it does |
|---|---|---|---|
| `onix-bap`, `onix-bpp` | 8081, 8082 | Beckn starter kit (official) | Sign, verify, validate and route every message |
| `redis` | 6379 | Beckn starter kit | The adapters' cache and message store |
| `sandbox-bap` | 3001 | **this repo** | Buyer-side app: the `/v1` REST API, one record per search, pushes events to the partner |
| `sandbox-bpp` | 3002 | **this repo** | Provider-side app: matching, double-reservation guard, offers, applies decisions |
| `edge` | 3010 (this machine only) | **this repo** | The only thing exposed to the internet: `/v1/*` and nothing else |
| `tunnel` | none | Cloudflare | Optional public https URL for the edge, no account needed |
| `beckn-router` | 9000 | Beckn starter kit | Not used by this system |

The two `sandbox-*` names come from the starter kit; the code inside is ours.
The built-in demo pages (Naledi's phone view and the provider console) are at
<http://localhost:3001/live> once it is running.

### How one request travels (for example a search)

1. The partner calls `POST /v1/search` with the practitioner's need.
2. `sandbox-bap` builds the Beckn message and sends it to `onix-bap`, which
   validates and signs it and forwards it to `onix-bpp`.
3. `onix-bpp` checks the signature (looking up the sender's public key in the
   network registry), validates the schema, and hands it to `sandbox-bpp`.
4. `sandbox-bpp` asks the partner's `GET /network/match` "does WeHelp match?",
   then answers with `on_discover`, which travels back the same way.
5. The partner is told with a `practitioner.matched` event.

Every Beckn request gets an immediate acknowledgement; the real answer arrives
later as a separate `on_*` message. That is why the partner gets **events**
instead of waiting on a response.

---

## Quick start

### Prerequisites

| You need | Notes |
|---|---|
| Docker Desktop | On Windows also enable Settings > Resources > WSL Integration for your Ubuntu distro |
| WSL 2 with Ubuntu (Windows only) | Run every command below inside the Ubuntu terminal |
| `git`, `curl` | Both are normally already in Ubuntu |
| Node 18+ | Only for the test suites in `tests/`, not for running the network |
| Internet access | The adapters fetch signing keys from the network registry; the images are pulled from Docker Hub |

Windows hardware note: WSL 2 and Docker need **CPU virtualization enabled in the
BIOS** (Intel VT-x or AMD-V), and if `wsl` complains, run
`wsl --install --no-distribution` once in an administrator PowerShell and restart.

### Run it

From the repository root, in the Ubuntu terminal:

```bash
bash setup.sh              # once: checks Docker, fetches the Beckn starter kit, installs our apps,
                           #       makes the one config change it needs, creates a strong API key
bash start.sh --tunnel     # starts everything and opens a public https URL
```

`start.sh` finishes by printing the **Public API URL** and the **API key**. Then:

```bash
bash check.sh              # confirms our side works and does a real search through both adapters
```

(`--tunnel` is only needed when an outside backend has to reach you. Without it
everything runs on this machine. Scripts are also runnable as `./setup.sh` if
your checkout kept the executable bit.)

### Command reference

| Command | What it does |
|---|---|
| `bash setup.sh` | One-time prerequisites; safe to re-run |
| `bash start.sh [--tunnel]` | Start everything; `--tunnel` adds the public URL (it changes on each start) |
| `bash connect.sh <address>` | Point the network at a partner's backend, restart, and run `check.sh`. `--off` disconnects |
| `bash check.sh` | Checks our side, the partner's two endpoints (if connected), and a real round trip |
| `bash stop.sh` | Stop everything (saved state is kept) |
| `bash start.sh --reference` | Also run the reference partner app and connect to it (for testing) |

---

## How to connect a partner backend

There are two roles. **You** run the network; **they** run the backend that connects to it.

### You (the network side)

1. `bash setup.sh` then `bash start.sh --tunnel`.
2. Send the partner, **privately**: the Public API URL, the API key, the
   [`partner-kit/`](partner-kit/) folder and [`docs/PARTNER-CONTRACT.md`](docs/PARTNER-CONTRACT.md).
3. When they send back their address (for example `https://their-app.run.app/api/v1`):

   ```bash
   bash connect.sh https://their-app.run.app/api/v1
   ```

   That saves the address, restarts our two apps with it, and runs `check.sh`,
   which tests their endpoints (health, match, events, wrong-key refusal) and a
   real search through both adapters.

### They (the partner)

Everything is in [`partner-kit/README.md`](partner-kit/README.md). In short:

1. Copy `partner-kit/network-kit/` into their Express app.
2. Set two environment variables: `NETWORK_BASE_URL` (our public URL) and
   `NETWORK_API_KEY`. On Cloud Run, set minimum instances to 1.
3. Add about ten lines: mount the router (`/network/match`, `/network/events`) and
   call the client from their existing handlers (signup, offer, accept, assign,
   complete).
4. Deploy, and send us the address.

The kit does nothing while its variables are unset, and every network call fails
softly, so their app keeps working on its own logic if the network is missing or
down. [`partner-kit/examples/reference-app.js`](partner-kit/examples/reference-app.js)
is a complete working example.

### What they call, and what calls them

| They call us (`X-Api-Key`) | When | We call them (`X-Api-Key`) |
|---|---|---|
| `POST /v1/search` | Naledi signs up | `GET /network/match`: "does this provider match?" |
| `POST /v1/provider/offer` | WeHelp sends an offer | `POST /network/events`: one event at a time |
| `POST /v1/select` | Naledi accepts | `GET /network/health`: reachability |
| `POST /v1/provider/decision` | WeHelp accepts or declines, with a coach | |
| `POST /v1/confirm`, `POST /v1/provider/complete` | Naledi confirms, WeHelp delivers | |
| `GET /v1/status/{id}`, `GET /v1/results/{id}` | any time | |

Events they receive: `practitioner.matched`, `offer.received`, `request.received`,
`status.changed`. Statuses: `searching`, `results_ready`, `pending`, `reserved`,
`confirming`, `fulfilled`, `rejected`, `error`. Every field, error code and
example is in [`docs/PARTNER-CONTRACT.md`](docs/PARTNER-CONTRACT.md).

---

## Configuration

`setup.sh` and `connect.sh` manage `~/starter-kit/generic-devkit/install/.env`
for you (never committed). The main settings:

| Variable | Default | Purpose |
|---|---|---|
| `API_KEY` | generated | Shared secret in `X-Api-Key`, both directions |
| `MATCH_URL` | empty | The partner's `/network/match`. Empty means the built-in providers are used |
| `EVENTS_URL` | empty | The partner's `/network/events`. Empty means events are only recorded |
| `BAP_ID`, `BPP_ID`, `NETWORK_ID` | shared sandbox identities | Network identity (keys stay in the adapters' config) |

The full list, including timeouts, is in [docs/INTEGRATION.md](docs/INTEGRATION.md).

---

## Safety and reliability, in plain terms

- **One door.** Only `/v1/*` is reachable from outside, and only with the API
  key. The built-in pages' open routes, the adapters' webhooks and the adapters
  themselves stay on the internal network.
- **Nothing is lost on restart.** Searches, needs, pending requests and events
  waiting to be delivered are saved to disk; a restart of either app carries on.
- **Events are delivered once or retried.** If the partner is down or slow, we
  retry in order with a growing pause; each event has a unique `eventId` so a
  repeat can be ignored.
- **No double reservations.** The provider side refuses a request for a need that
  is already reserved, fulfilled, or being decided (four cases, including two
  requests at the same instant, are tested).
- **The partner is never a single point of failure for us**, and the kit makes
  sure **we are never one for them**: their app falls back to local logic.

---

## Testing

| Suite | Command | Result on the final code |
|---|---|---|
| Network, standalone | `API_KEY=<key> node tests/e2e.js` | 88/88 |
| Network with a stand-in partner (retries, outage, restart) | `bash start.sh --mock` then `API_KEY=<key> node tests/e2e.js --delegated` | 98/98 |
| The whole story through the reference partner app | `bash start.sh --reference` then `API_KEY=<key> node tests/partner-flow.js` | 32/32 |
| The same with every hop over the public internet | as above, with `REF=<their public address>/api/v1 EDGE=<our public URL> PUBLIC_URL=<our public URL>` set (see the file header) | 35/35 |

The key is in `~/starter-kit/generic-devkit/install/.env`. The suites also audit
the adapters' own logs: no errors, no schema rejections, no message leaving our
network. Everything was run starting from a brand-new clone of the starter kit
using only `setup.sh` and `start.sh`.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `docker is not reachable` | Start Docker Desktop and enable WSL integration for your distro |
| WSL says "virtualization is not enabled" | Turn on Intel VT-x / AMD-V in the BIOS, then `wsl --install --no-distribution` (administrator PowerShell) and restart |
| `wsl --install` fails fetching the distro list | The list host is blocked on some networks. If Ubuntu is already installed you don't need it: use `wsl --install --no-distribution` |
| "address already in use" | Another copy is running. `bash stop.sh`, then start again |
| `permission denied` running a script | Run it as `bash start.sh` (and so on) |
| `401 unauthorized` from our API | The key doesn't match. Read it: `grep API_KEY ~/starter-kit/generic-devkit/install/.env` |
| A search returns `error` / `network_rejected` right after start | The adapters were still starting. `start.sh` now waits for them; otherwise see `docker logs onix-bap` |
| `check.sh` says "no match for the sample practitioner" | The partner's match rules don't accept Alexandra / Pre-Bronze / 28 children. Check their `/network/match` |
| The partner isn't receiving events | `curl http://localhost:3010/v1/health` shows `outboxPending`; look at `docker logs sandbox-bap`. We retry up to 20 times with backoff |
| No public URL, or `check.sh` says it doesn't answer | Some networks block the tunnel: `docker logs naledi-tunnel`. The URL is random and changes every start, so resend it |
| Messages fail and logs mention the registry | The adapters need internet to fetch signing keys; check connectivity |

---

## Limits (what this is not, yet)

- **Identities are the starter kit's shared sandbox ones** (`bap.example.com`,
  `bpp.example.com`). They prove "a sandbox adapter sent this", not "our
  organisation sent this". **Use only made-up data.** Real identities mean
  registering our own in a network registry, which is a governance decision
  (who runs it, who may join, what the network is called) still to be made.
- All providers sit behind one provider identity; a provider is a record inside
  `sandbox-bpp`, not a separate network participant.
- The partner side is whatever they build; their demo server keeps state in
  memory, so a redeploy on their side loses it.
- The public tunnel is demo-grade (random URL, no uptime promise).
- The `note` sent with a confirm stays in our record and does not travel through
  the network.
- The adapters log a harmless `duplicate message_id` warning on ordinary replies.

---

## Repository layout

```
README.md                          you are here
setup.sh start.sh stop.sh          the commands (lib.sh holds the shared helpers)
connect.sh check.sh
docker-compose.override-naledi.yml swaps in our apps, adds the edge, tunnel and test services
edge.Caddyfile                     the edge proxy: /v1/* only
.env.example                       the settings (the real .env is created by setup.sh)
our-backend-naledi/                our code: buyer app, provider app, shared helpers, test stand-in
partner-kit/                       what the partner copies: network-kit/ + a working reference app + README
tests/                             e2e.js (network) and partner-flow.js (the whole story)
docs/PARTNER-CONTRACT.md           the exact API, events, errors and rules, in "I / you" voice
docs/INTEGRATION.md                the operator's guide: design, configuration, state, verification
docs/MANUAL-SETUP.md               the older manual setup, kept for reference
```

The Beckn starter kit itself is fetched by `setup.sh` into `~/starter-kit` and is
not part of this repository.

---

## Glossary

| Term | Meaning |
|---|---|
| **Beckn** | An open protocol for independent organisations to discover each other and transact over a shared network |
| **BAP** | Beckn Application Platform: acts for the person who needs something (here, Naledi's side) |
| **BPP** | Beckn Provider Platform: acts for the provider (here, WeHelp's side) |
| **Adapter (ONIX)** | The official software in front of each side that signs, validates and routes messages |
| **Registry** | The directory of network participants and their public keys |
| **discover / select / init / confirm** | The steps: find providers, choose one, set terms, finalise |
| **on_discover, on_init ...** | The provider's later replies; every request is acknowledged at once and answered afterwards |
| **Transaction id** | The id that ties every message of one search-to-fulfilment together |
| **Standing search** | Naledi's signup search, kept open so a later offer can answer it |
| **Edge** | The small proxy that exposes only the partner API to the internet |
