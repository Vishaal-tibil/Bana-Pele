"""
BPP service -- one real HTTP process per provider, same role as
real_protocol/bpp_service.py, extended with the two biggest doc-alignment
gaps closed:

1. A real accept/decline gate for full-transaction providers. Real Beckn
   ACKs `select` immediately and answers later via `on_select` -- this
   version uses that gap honestly: instead of always auto-accepting in a
   background task, the request sits in `_pending` until this provider's
   own console explicitly accepts or declines it (see /provider/pending
   below). That's what the UC2 narrative in the doc means by "The Thabo
   reviews... accepts, declines..." -- and it's what makes a provider
   app a real second party instead of an auto-accept simulation.
   discovery_only providers are unchanged: still a synchronous NACK,
   since there's nothing to accept.

2. Two more real lifecycle steps past confirm: fulfil (provider marks the
   support actually delivered) and verify (participant confirms it
   happened), closing Appendix B's Commitment lifecycle
   (RESERVED -> FULFILLED -> VERIFIED) instead of stopping at confirm.

Each BPP keeps its own small `_orders` view of every transaction it's
party to -- deliberately not shared state with the BAP's store, since two
independent systems each keeping their own view of a shared transaction
is what "network of independent nodes" actually means.

Env vars (same pattern as real_protocol): BPP_ID, BPP_PORT, BPP_DOMAIN.
    BPP_ID=smartstart BPP_PORT=9601 BPP_DOMAIN=ngo-support \\
        uvicorn network_v2.bpp_service:app --port 9601
"""
import os

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from domains import coaching, ngo_support
from network_v2.schemas import (
    AckResponse, Catalog, CatalogItem, CatalogProvider, Descriptor,
    OnOrderRequest, OnSearchMessage, OnSearchRequest, Order, OrderMessage,
    OrderProviderRef, OrderRequest, SearchRequest, ack, nack,
)

DOMAIN_MODULES = {"ngo-support": ngo_support, "coaching": coaching}

PROVIDER_ID = os.environ["BPP_ID"]
PORT = int(os.environ["BPP_PORT"])
DOMAIN = os.environ.get("BPP_DOMAIN", "ngo-support")
SELF_URL = f"http://127.0.0.1:{PORT}"

_provider = next(p for p in DOMAIN_MODULES[DOMAIN].build_providers() if p.id == PROVIDER_ID)

app = FastAPI(title=f"BPP-v2:{PROVIDER_ID}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:9503", "http://127.0.0.1:9503"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# tx_id -> {"context": Context, "item_id": str}  -- awaiting this provider's accept/decline
_pending: dict[str, dict] = {}
# tx_id -> order dict (this provider's own view of the transaction)
_orders: dict[str, dict] = {}
# tx_id -> bap_uri, so a fulfil (which can happen much later) knows where to call back
_bap_uri_by_tx: dict[str, str] = {}


@app.get("/health")
def health():
    return {"status": "ok", "provider": PROVIDER_ID}


@app.get("/catalog")
def catalog():
    """Not part of the Beckn spec -- a direct, unfiltered read of exactly
    what this specific process is holding, independent of any search or
    match logic. Proof this provider's data really lives here, in this
    one process, not in some shared store the Gateway hands out."""
    return {
        "provider_id": _provider.id,
        "name": _provider.name,
        "domain": DOMAIN,
        "participation_type": _provider.participation_type,
        "port": PORT,
        "items": [{"id": i.id, "name": i.name, "attributes": i.attributes} for i in _provider.items],
    }


async def _post(url: str, path: str, body: dict) -> None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            await client.post(f"{url}{path}", json=body)
        except httpx.HTTPError as exc:
            print(f"  [BPP-v2:{PROVIDER_ID}] callback to {url}{path} failed: {exc}")


def _matching_items(intent):
    """Real relevance matching, same approach as real_protocol, plus a
    short match_reason string per item (Appendix B's 'fit explanation')."""
    query = (intent.category.name if intent.category else "").strip().lower()
    region = str(intent.tags.get("region") or "").strip().lower()

    results = []
    for item in _provider.items:
        reasons = []
        if query:
            haystack = {
                "name": item.name.lower(),
                "id": item.id.lower(),
                **{k: str(v).lower() for k, v in item.attributes.items()},
            }
            hit_fields = [k for k, v in haystack.items() if query in v]
            if not hit_fields:
                continue
            reasons.append(f"matched \"{query}\" in {', '.join(hit_fields)}")
        if region:
            item_region = str(item.attributes.get("region", "")).lower()
            if region not in item_region:
                continue
            reasons.append(f"serves \"{region}\"")
        results.append((item, "; ".join(reasons) if reasons else "matches your open search"))
    return results


async def _do_on_search(req: SearchRequest) -> None:
    matched = _matching_items(req.message.intent)
    if not matched:
        print(f"  [BPP-v2:{PROVIDER_ID}] nothing relevant -- staying silent, no on_search sent.")
        return
    ctx = req.context.for_callback("on_search", PROVIDER_ID, SELF_URL)
    catalog = Catalog(providers=[CatalogProvider(
        id=_provider.id,
        descriptor=Descriptor(name=_provider.name),
        participation_type=_provider.participation_type,
        items=[CatalogItem(id=i.id, descriptor=Descriptor(name=i.name), tags=i.attributes, match_reason=reason)
               for i, reason in matched],
    )])
    body = OnSearchRequest(context=ctx, message=OnSearchMessage(catalog=catalog)).model_dump()
    print(f"  [BPP-v2:{PROVIDER_ID}] on_search -> POST {req.context.bap_uri}/on_search "
          f"({len(matched)}/{len(_provider.items)} item(s) matched)")
    await _post(req.context.bap_uri, "/on_search", body)


@app.post("/search", response_model=AckResponse)
async def search(req: SearchRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(_do_on_search, req)
    return ack(req.context)


@app.post("/select", response_model=AckResponse)
async def select(req: OrderRequest):
    if _provider.participation_type == "discovery_only":
        print(f"  [BPP-v2:{PROVIDER_ID}] NACK -- discovery-only, cannot process 'select'.")
        return nack(req.context, code="30001",
                    message="This provider is discovery-only. Contact them directly to proceed.")
    if not req.message.order.items:
        return nack(req.context, code="40000", message="order.items must not be empty.")
    item_id = req.message.order.items[0].id
    if not any(i.id == item_id for i in _provider.items):
        return nack(req.context, code="40001", message=f"No such item '{item_id}'.")

    tx_id = req.context.transaction_id
    _pending[tx_id] = {"context": req.context, "item_id": item_id}
    _orders[tx_id] = {"provider": {"id": PROVIDER_ID}, "items": [{"id": item_id}], "status": "PENDING"}
    _bap_uri_by_tx[tx_id] = req.context.bap_uri
    print(f"  [BPP-v2:{PROVIDER_ID}] select queued as PENDING -- awaiting this provider's own accept/decline.")
    return ack(req.context)


# ---- provider-facing console endpoints (not part of the Beckn spec --
# this is what the Provider webapp talks to, same role bap_service.py's
# /client/* has for Naledi's webapp) ----

@app.get("/provider/pending")
def list_pending():
    return [{"tx_id": tx_id, "item_id": v["item_id"]} for tx_id, v in _pending.items()]


@app.post("/provider/pending/{tx_id}/accept")
async def accept_pending(tx_id: str):
    entry = _pending.pop(tx_id, None)
    if entry is None:
        raise HTTPException(404, "no pending request with this transaction id")
    ctx = entry["context"]
    item = next(i for i in _provider.items if i.id == entry["item_id"])
    order = Order(provider=OrderProviderRef(id=PROVIDER_ID),
                  items=[{"id": item.id}], quote=item.attributes, status="QUOTED")
    _orders[tx_id] = order.model_dump()
    on_ctx = ctx.for_callback("on_select", PROVIDER_ID, SELF_URL)
    print(f"  [BPP-v2:{PROVIDER_ID}] accepted -> on_select (QUOTED) -> POST {ctx.bap_uri}/on_select")
    await _post(ctx.bap_uri, "/on_select",
                OnOrderRequest(context=on_ctx, message=OrderMessage(order=order)).model_dump())
    return {"status": "accepted"}


@app.post("/provider/pending/{tx_id}/decline")
async def decline_pending(tx_id: str, reason: str = "Not available right now."):
    entry = _pending.pop(tx_id, None)
    if entry is None:
        raise HTTPException(404, "no pending request with this transaction id")
    ctx = entry["context"]
    order = Order(provider=OrderProviderRef(id=PROVIDER_ID),
                  items=[{"id": entry["item_id"]}], status="DECLINED", decline_reason=reason)
    _orders[tx_id] = order.model_dump()
    on_ctx = ctx.for_callback("on_select", PROVIDER_ID, SELF_URL)
    print(f"  [BPP-v2:{PROVIDER_ID}] declined -> on_select (DECLINED) -> POST {ctx.bap_uri}/on_select")
    await _post(ctx.bap_uri, "/on_select",
                OnOrderRequest(context=on_ctx, message=OrderMessage(order=order)).model_dump())
    return {"status": "declined"}


async def _do_on_order(action: str, req: OrderRequest) -> None:
    on_action = f"on_{action}"
    ctx = req.context.for_callback(on_action, PROVIDER_ID, SELF_URL)
    order = req.message.order
    if action == "init":
        order = order.model_copy(update={"status": "INITIATED"})
    elif action == "confirm":
        order = order.model_copy(update={
            "id": f"{PROVIDER_ID}-{req.context.transaction_id}", "status": "RESERVED",
        })
    _orders[req.context.transaction_id] = order.model_dump()
    _bap_uri_by_tx[req.context.transaction_id] = req.context.bap_uri
    print(f"  [BPP-v2:{PROVIDER_ID}] {on_action} -> POST {req.context.bap_uri}/{on_action}")
    await _post(req.context.bap_uri, f"/{on_action}",
                OnOrderRequest(context=ctx, message=OrderMessage(order=order)).model_dump())


def _order_endpoint(action: str):
    async def handler(req: OrderRequest, background_tasks: BackgroundTasks):
        if _provider.participation_type == "discovery_only":
            return nack(req.context, code="30001",
                        message="This provider is discovery-only. Contact them directly to proceed.")
        background_tasks.add_task(_do_on_order, action, req)
        return ack(req.context)
    return handler


app.post("/init", response_model=AckResponse)(_order_endpoint("init"))
app.post("/confirm", response_model=AckResponse)(_order_endpoint("confirm"))


# ---- fulfilment + verification (the two steps real_protocol doesn't have) ----

@app.get("/provider/commitments")
def list_commitments():
    """Reserved orders awaiting this provider marking them delivered."""
    return [{"tx_id": tx_id, **o} for tx_id, o in _orders.items() if o.get("status") == "RESERVED"]


@app.post("/provider/commitments/{tx_id}/fulfil")
async def fulfil(tx_id: str, note: str = "Support delivered."):
    order = _orders.get(tx_id)
    if order is None or order.get("status") != "RESERVED":
        raise HTTPException(400, "no RESERVED commitment with this transaction id")
    order = {**order, "status": "FULFILLED", "fulfilment_note": note}
    _orders[tx_id] = order
    bap_uri = _bap_uri_by_tx.get(tx_id)
    ctx_payload = {
        "domain": DOMAIN, "action": "on_fulfil", "bap_id": "nfh-bap-v2", "bap_uri": bap_uri,
        "bpp_id": PROVIDER_ID, "bpp_uri": SELF_URL, "transaction_id": tx_id,
    }
    print(f"  [BPP-v2:{PROVIDER_ID}] fulfilled -> on_fulfil -> POST {bap_uri}/on_fulfil")
    if bap_uri:
        await _post(bap_uri, "/on_fulfil", {"context": ctx_payload, "message": {"order": order}})
    return {"status": "fulfilled"}


@app.post("/on_verify")
def on_verify(payload: dict):
    """Courtesy notification from the BAP once the participant verifies --
    optional, purely so this provider's own console reflects VERIFIED too."""
    tx_id = payload.get("context", {}).get("transaction_id")
    if tx_id in _orders:
        _orders[tx_id]["status"] = "VERIFIED"
    return {"status": "noted"}


@app.get("/provider/history")
def list_history():
    """Everything this provider has been party to, most-recent-ish first --
    used by the provider console's 'completed' list."""
    return [{"tx_id": tx_id, **o} for tx_id, o in _orders.items() if o.get("status") in ("FULFILLED", "VERIFIED")]
