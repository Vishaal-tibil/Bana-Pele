# network_v2 -- the latest system

A network of separate, independently-running processes -- a Registry, a
Gateway, a BAP, one process per provider, and a shared adapter for providers
that don't run their own -- plus five browser pages to drive and inspect it.
It is a self-contained system: it does not import from `real_protocol/` or
`frontend/` and shares no runtime state with them. The only thing it reads
from the rest of the repo is the catalog in `domains/`.

It exists to implement more of **Appendix B (Bana Pele ECD Network design)**
of `A13-Digital-Backbone-Functional-v22Sep2026.pdf` than `real_protocol/`
does. Read [`../PROJECT_OVERVIEW.md`](../PROJECT_OVERVIEW.md) for the story;
this file is the reference for the code.

## Run it

From the **repo root** (not from inside this folder):

```bash
pip install -r requirements.txt        # once
python -m network_v2.serve             # Windows: python   |  macOS/Linux: python3
```

Leave that terminal open -- it keeps all the processes alive. **Ctrl+C**
stops every one of them. Then open **http://127.0.0.1:9503**.

| Port | Process | File |
|---|---|---|
| 9501 | Registry | `registry.py` |
| 9502 | Gateway | `gateway.py` |
| 9503 | BAP (also serves the web pages) | `bap_service.py` |
| 9601, 9602 | SmartStart, Grow -- independent providers | `bpp_service.py` (one process each) |
| 9605 | My Journey Network Adapter (answers for Imbe) | `journey_adapter.py` |
| 9607, 9608, 9609 | Thabo A, B, C -- independent providers | `bpp_service.py` (one process each) |

That is **9 processes**. Independent providers get ports counting up from
9601 (UC1) and 9607 (UC2) in the order they appear in `domains/`; the
adapter is fixed at 9605. It can run alongside `real_protocol` (ports 9001+),
`api.py` (8000) and the React dev server (5173) -- no shared ports.

If you see `Errno 10048` / "address already in use", an older copy is still
running -- see the troubleshooting section in the root [`README.md`](../README.md).
All state (transactions, orders, consent grants) is **in memory**: restarting
clears it.

## The pages

All served by the BAP process, so there is one thing to run and one port to open.

| URL | File | Purpose |
|---|---|---|
| `/` | `webapp/landing.html` | Links to everything |
| `/naledi` | `webapp/naledi.html` | Seeker's app: log in -> search -> results -> consent -> request -> confirm -> verify -> receipt. A progress bar shows the stage |
| `/provider` | `webapp/provider.html` | Provider console: log in as any registered provider -> Inbox (accept/decline) / Active (mark fulfilled) / Completed |
| `/live` | `webapp/live.html` | The two above side by side (two iframes). Best way to watch a transaction happen |
| `/network` | `webapp/network.html` | Network Console: topology diagram, live health of every node, every provider's catalog, every transaction's message trace |

They are plain HTML/CSS/JS -- no build step, no external fonts or CDNs.
Editing an `.html` file takes effect on a browser refresh.

The Network Console is the one that proves the network is real: its
JavaScript calls **each node's own port directly from your browser** (open
devtools -> Network to watch), not through the BAP. That is why Registry,
Gateway and every BPP enable CORS for `http://127.0.0.1:9503`.

The login screens are honest labels, not authentication: Naledi's name is
attached to what she searches and requests; the provider picks which
registered provider they are. Nothing is verified.

## How a request flows

```
Browser (/naledi)
   |  POST /client/search
   v
BAP ---- POST /search ----> Gateway ---- GET /lookup ----> Registry
 ^                            |
 |                            +---- POST /search ----> every BPP in that domain
 |                                                      (each decides for itself
 +---- POST /on_search <----------------------------     whether it has a match;
       (only from providers with a match)                 no match = no reply)

   ...then the seeker picks one; from here the Gateway is out of the picture:

BAP ---- POST /select ----> that one BPP   -> ACK now, PENDING until its console accepts
BAP <---- POST /on_select --- BPP           (QUOTED if accepted, DECLINED if not)
BAP ---- POST /init    ----> BPP  -> BAP <- /on_init      (INITIATED)
BAP ---- POST /confirm ----> BPP  -> BAP <- /on_confirm   (RESERVED, order id assigned)
Provider console -> BPP  POST /provider/commitments/{tx}/fulfil
BAP <---- POST /on_fulfil --- BPP                         (FULFILLED)
Browser -> BAP  POST /client/verify                       (VERIFIED)
```

Two properties to notice: **every request gets an immediate ACK or NACK**, and
the real content arrives later as a separate call back to the BAP (that is the
async pattern); and **the Gateway only ever handles `/search`** -- it has no
route for select/init/confirm at all, so those cannot pass through it.

Order status moves through: `PENDING -> QUOTED -> INITIATED -> RESERVED ->
FULFILLED -> VERIFIED`, or `PENDING -> DECLINED`.

A **discovery-only** provider answers a search but replies to `select` with an
immediate NACK (`30001`, "This provider is discovery-only. Contact them
directly to proceed."). It never gets an order.

## Code map

```
network_v2/
  serve.py            Launcher. Starts every process, waits until each answers
                      /health, registers them all with the Registry, then idles
                      until Ctrl+C.
  schemas.py          The message shapes (pydantic): Context, ack/nack, search and
                      catalog types, Order + OrderStatus, ConsentGrant.
  registry.py         Who is registered for which domain, at which URL.
  gateway.py          Forwards a /search to everyone the Registry lists for that
                      domain. ~50 lines; deliberately does nothing else.
  bap_service.py      Acts for the seeker. The /client/* API the pages call, the
                      /on_* webhooks providers call back, and the page routes.
  bpp_service.py      ONE provider. The same file is launched once per provider;
                      env vars (BPP_ID, BPP_PORT, BPP_DOMAIN) pick which catalog
                      entry it serves. Matching, the accept/decline gate,
                      fulfil, and its /catalog endpoint.
  journey_adapter.py  The My Journey Network Adapter: one process that answers
                      for several Platform-mediated providers (Imbe today).
  webapp/             The five HTML pages.
  requirements.txt    fastapi, uvicorn[standard], pydantic, httpx
```

Two design points worth knowing when reading the code:

- **`bpp_service.py` is generic.** Nothing in it is specific to SmartStart or
  Thabo A. Add a provider to `domains/` and `serve.py` launches another copy.
- **`journey_adapter.py` looks like a BPP to everyone else.** It registers with
  the same `/subscribe`, answers the same `/search`/`/select`/... routes and
  returns the same ack/nack shapes. It sends one `on_search` per provider it
  represents, each attributed to *that* provider's id but carrying the
  adapter's URL -- which is how later `select`/`init`/`confirm` calls find their
  way back to it. The Registry row carries `participation_pattern:
  "platform_mediated"` (vs `"independent"`) so the difference is stated, not
  inferred.

## Endpoint reference

**Registry (9501)** -- `GET /health` -- `POST /subscribe` (register a node) --
`GET /lookup?domain=&type=`

**Gateway (9502)** -- `GET /health` -- `POST /search`

**BAP (9503)**

| Route | Purpose |
|---|---|
| `GET /`, `/naledi`, `/provider`, `/live`, `/network` | The pages |
| `GET /health` | Liveness |
| `GET /client/providers?domain=` | Who is registered (proxies the Registry) |
| `POST /client/search?domain=&category=&region=&participant_name=` | Start a search; returns a `transaction_id` |
| `GET /client/results/{tx}` | The `on_search` replies received so far |
| `POST /client/consent` (JSON body) | Record a consent grant, get a `consent_ref` |
| `POST /client/select?tx_id=&bpp_id=&item_id=&consent_ref=` | Request an item. `consent_ref` is optional, but if given it must exist (403 otherwise). The Naledi page always sends one |
| `POST /client/init`, `/client/confirm?tx_id=&bpp_id=` | Advance the order |
| `POST /client/verify?tx_id=&bpp_id=` | Seeker confirms delivery (order must be FULFILLED) |
| `GET /client/order/{tx}` | Current order state |
| `GET /client/log/{tx}` | Every message sent/received for a transaction |
| `GET /client/transactions` | Every transaction this BAP has seen |
| `POST /on_search`, `/on_select`, `/on_init`, `/on_confirm`, `/on_fulfil` | Webhooks the providers call |

**Each BPP (and the adapter)**

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /catalog` | That provider's raw catalog (adapter: `?provider_id=` picks which one) |
| `POST /search`, `/select`, `/init`, `/confirm` | The protocol calls |
| `GET /provider/pending` | Requests waiting for accept/decline |
| `POST /provider/pending/{tx}/accept` , `/decline?reason=` | Answer a request |
| `GET /provider/commitments` | Reserved orders awaiting delivery |
| `POST /provider/commitments/{tx}/fulfil?note=` | Mark delivered |
| `GET /provider/history` | Fulfilled / verified orders |
| `POST /on_verify` | Courtesy notice from the BAP after the seeker verifies |

Try one directly (needs the system running):

```bash
curl "http://127.0.0.1:9503/client/providers?domain=ngo-support"
curl http://127.0.0.1:9601/catalog
curl -X POST "http://127.0.0.1:9503/client/search?domain=coaching&category=Sesotho&region="
```

## What's implemented from Appendix B, and what differs from `real_protocol`

| | `real_protocol` | `network_v2` |
|---|---|---|
| Lifecycle | search -> select -> init -> confirm | ... -> **fulfil -> verify** |
| A full-transaction provider can say no | no -- auto-accepts | **yes** -- request waits as PENDING until the provider's own console accepts or declines |
| Consent | none | a stored grant with a ref (`POST /client/consent`); validated on select when supplied |
| Why a result matched | not shown | each item carries a `match_reason` |
| Who is asking | anonymous | `participant_name` carried on every message |
| Platform-mediated providers | not modelled | **the My Journey Network Adapter** |
| Ports | 9001-9003, 9101+ | 9501-9503, 9601+ |
| UI | React trace tool | five HTML pages on the BAP |

## Search matching

A provider replies to a search only if it has something relevant. The check
(`_matching_items` in `bpp_service.py` / `journey_adapter.py`) lower-cases the
search text and looks for it as a substring in each item's name, id and
**every attribute value**; a region filter, if given, must appear in the
item's `region`. A blank search matches everything. This is plain substring
matching over whatever the catalog contains -- it is not language-aware or
semantic. (`Sesotho` finds Thabo A only because his catalog entry has
`language: Sesotho`.)

## The catalog

Lives in `../domains/ngo_support.py` and `../domains/coaching.py`. Each file's
docstring says where every name and category comes from (the architecture
document, or a named sibling artifact) -- there is no invented filler.
`ngo_support.py` returns two lists: `build_providers()` (independent) and
`build_mediated_providers()` (served by the adapter).

## Out of scope

No real authentication, message signing or schema-file validation; no live
catalog publishing; no TTL enforcement; the consent grant is stored but does
not yet restrict what data flows; and nothing above the network layer -- the
Journey Platform, Elevate integration, AI knowledge services and programme
dashboard are not built.
