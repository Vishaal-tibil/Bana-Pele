# Real-protocol sketch

Same UC1 + UC2 story as `shared/network.py` + `domains/*.py` (Registry,
Gateway, BAP, one BPP per provider in `domains/ngo_support.py` +
`domains/coaching.py` -- currently 3 + 3 = 6 -- discovery-only vs
full-transaction), rebuilt so the nodes are genuinely separate HTTP
services instead of Python classes calling each other's methods directly.

## What's real here (vs. `shared/` + `api.py`)

- **Separate services, separate ports.** Registry (9001), Gateway (9002),
  BAP (9003), one process per ngo-support provider starting at 9101, and
  one process per coaching provider starting at 9107 -- `run_demo.py`/
  `serve.py` launch each with `subprocess.Popen`, not `asyncio` calls in
  one process. The provider count (and so the exact port range used)
  follows whatever's in `domains/*.py` -- it's currently 3 ngo-support +
  3 coaching (Imbe runs here as one more ordinary process -- this system has
  no adapter concept), not the 6 + 5 this used to say, because that catalog was
  rewritten to only use names and categories the architecture doc
  actually names (see `domains/ngo_support.py`'s docstring).
- **Real relevance matching.** Each BPP's `on_search` handler
  (`bpp_service.py`'s `_matching_items`) actually filters its catalog
  against the intent's free-text category and region tag -- an empty
  search browses everything, a specific one only returns matching items,
  and a provider with nothing relevant stays silent (no on_search at all)
  instead of always dumping its whole catalog regardless of what was
  asked.
- **Real Beckn context.** [schemas.py](schemas.py)'s `Context` carries
  `domain`, `country`, `city`, `core_version`, `bap_id`/`bap_uri`,
  `bpp_id`/`bpp_uri`, `transaction_id`, `message_id`, `ttl` -- the fields a
  real BPP needs to know where to send its callback, not just who's asking.
- **Genuine async ACK-then-callback.** `POST /search` returns only an
  `{"message": {"ack": {"status": "ACK"}}}` immediately; the actual catalog
  arrives later as a separate `POST {bap_uri}/on_search` the BPP fires off
  in a background task. Same pattern for select/init/confirm ->
  on_select/on_init/on_confirm. This is the biggest structural gap the
  original mock's README calls out, and it's the main thing this sketch
  fixes.
- **Gateway only brokers discovery.** `select`/`init`/`confirm` go directly
  BAP -> BPP once the BAP has a `bpp_uri` from `on_search`, same as real
  Beckn -- the gateway never sees them.
- **discovery_only providers NACK synchronously**, with a real
  `error.code`/`error.message`, instead of quietly rejecting in the
  in-process return value.
- **The React frontend (`frontend/`) is wired to this**, not `api.py`. It
  has a real search box: what a person types becomes the actual search
  intent sent to `/client/search`, and the results shown are exactly
  whichever providers' `on_search` matched it. `frontend/src/api.ts` calls
  the BAP's `/client/*` endpoints directly and polls for the async
  on_search/on_select/on_init/on_confirm callbacks to land -- see
  [bap_service.py](bap_service.py)'s `/client/providers` and
  `/client/order/{tx_id}` helper endpoints (not part of the Beckn spec,
  just what a UI needs: the registered-provider list up front, and a way
  to read back the order state a callback just updated).

## What's still simplified

- No signing, no subscriber authentication, no schema-file validation
  against the actual Beckn JSON schemas (ONIX's job, not reproduced here).
- Registry and each BAP's transaction store are in-memory and single-process
  -- fine for a demo, not for a real deployment.
- The relevance matching is a plain substring match on free text + a
  region tag -- enough to prove search genuinely filters, not a real
  ranking/recall engine.
- No retry/timeout handling on the `ttl` field, no `status`/`track`/
  `cancel`/`rating`/`support` actions.

## Running it

**One-off scripted demo** (ngo-support only: boots, runs a fixed search ->
select -> init -> confirm + a discovery_only rejection, prints the message
trail, tears everything down):

```
pip install -r requirements.txt
python -m real_protocol.run_demo
```

**Live, for the frontend to drive** (both domains: boots all 9 services
-- registry, gateway, BAP, 3 ngo-support BPPs, 3 coaching BPPs -- and
registers them, then stays up -- Ctrl+C to stop):

```
python -m real_protocol.serve
```

Then, in another terminal:

```
cd frontend
npm install
npm run dev              # http://localhost:5173
```

To run the services standalone instead (e.g. to watch requests in a
network tab):

```
uvicorn real_protocol.registry:app --port 9001
uvicorn real_protocol.gateway:app --port 9002
BAP_PORT=9003 uvicorn real_protocol.bap_service:app --port 9003
BPP_ID=smartstart BPP_PORT=9101 uvicorn real_protocol.bpp_service:app --port 9101
# ...one BPP_ID/BPP_PORT pair per provider in domains/ngo_support.py
```
