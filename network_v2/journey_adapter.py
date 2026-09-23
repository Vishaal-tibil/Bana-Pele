"""
My Journey Network Adapter -- one real process that publishes and
answers on behalf of every "Platform-mediated" participant (Appendix B2:
"Uses Journey Platform forms, feeds, catalogues and managed workflows"),
instead of each of those participants running its own BPP process the
way SmartStart or Grow do.

From the Registry, Gateway and BAP's point of view this is completely
indistinguishable from any other BPP -- same /search, /select, /init,
/confirm shape, same ack/nack envelope. That's deliberate: the doc's
whole point about this pathway is that the *network* doesn't need to
know or care who's actually running the server behind a participant's
URL, only that the participant is registered and answers correctly. The
only real difference is operational -- one process here can represent
several participants that don't each want the integration burden of
running their own, which is the actual value of this pathway per
section 7 ("organisations with limited integration capacity or a need
for assisted participation").

Currently mediates: domains.ngo_support.build_mediated_providers()
(just "Imbe" today -- see that file's docstring for exactly where the
doc names it for this pathway). Adding a second mediated participant
later means adding it to that function; this file doesn't change.

    ADAPTER_PORT=9605 uvicorn network_v2.journey_adapter:app --port 9605
"""
import os

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from domains import ngo_support
from network_v2.schemas import (
    AckResponse, Catalog, CatalogItem, CatalogProvider, Descriptor,
    OnOrderRequest, OnSearchMessage, OnSearchRequest, Order, OrderMessage,
    OrderProviderRef, OrderRequest, SearchRequest, ack, nack,
)

ADAPTER_ID = "my-journey-adapter"
PORT = int(os.environ.get("ADAPTER_PORT", 9605))
SELF_URL = f"http://127.0.0.1:{PORT}"

# provider_id -> Provider, for every participant this adapter mediates.
# ngo-support only today (that's the one domain the doc names a
# Platform-mediated example for); extending to coaching would just mean
# adding a similarly-named build_mediated_providers() there and merging
# it in below.
_providers_by_id = {p.id: p for p in ngo_support.build_mediated_providers()}

app = FastAPI(title="My Journey Network Adapter")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:9503", "http://127.0.0.1:9503"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_pending: dict[str, dict] = {}          # tx_id -> {"context", "item_id", "provider_id"}
_orders: dict[str, dict] = {}           # tx_id -> order dict (+ "provider_id")
_bap_uri_by_tx: dict[str, str] = {}
_answered_search: set[str] = set()      # tx_ids already replied to -- see module docstring


@app.get("/health")
def health():
    return {"status": "ok", "adapter": ADAPTER_ID, "mediates": list(_providers_by_id)}


@app.get("/catalog")
def catalog(provider_id: str | None = None):
    """Same shape as a regular BPP's /catalog when `provider_id` is given
    (so the Network Console's existing per-card fetch works unchanged);
    without it, returns every participant this adapter mediates."""
    def shape(p):
        return {
            "provider_id": p.id, "name": p.name, "domain": ngo_support.DOMAIN,
            "participation_type": p.participation_type, "port": PORT,
            "items": [{"id": i.id, "name": i.name, "attributes": i.attributes} for i in p.items],
            "via": ADAPTER_ID,
        }
    if provider_id:
        p = _providers_by_id.get(provider_id)
        if p is None:
            raise HTTPException(404, f"this adapter does not mediate '{provider_id}'")
        return shape(p)
    return {"adapter": ADAPTER_ID, "mediates": [shape(p) for p in _providers_by_id.values()]}


async def _post(url: str, path: str, body: dict) -> None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            await client.post(f"{url}{path}", json=body)
        except httpx.HTTPError as exc:
            print(f"  [ADAPTER] callback to {url}{path} failed: {exc}")


def _matching_items(provider, intent):
    """Identical matching approach to bpp_service.py's _matching_items,
    applied per mediated provider."""
    query = (intent.category.name if intent.category else "").strip().lower()
    region = str(intent.tags.get("region") or "").strip().lower()
    results = []
    for item in provider.items:
        reasons = []
        if query:
            haystack = {"name": item.name.lower(), "id": item.id.lower(),
                        **{k: str(v).lower() for k, v in item.attributes.items()}}
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
    if req.context.transaction_id in _answered_search:
        return  # already answered this search once -- see module docstring
    _answered_search.add(req.context.transaction_id)

    # One on_search POST per matching mediated provider, each attributed
    # with THAT provider's own id (bpp_uri stays the adapter's shared
    # URL). Not one combined callback listing several -- the BAP's
    # on_search webhook tags every entry in a single callback with one
    # shared context.bpp_id, so a combined callback would mis-attribute
    # every provider after the first to whichever one bpp_id was used.
    any_matched = False
    for provider in _providers_by_id.values():
        matched = _matching_items(provider, req.message.intent)
        if not matched:
            continue
        any_matched = True
        ctx = req.context.for_callback("on_search", provider.id, SELF_URL)
        catalog = Catalog(providers=[CatalogProvider(
            id=provider.id, descriptor=Descriptor(name=provider.name),
            participation_type=provider.participation_type,
            items=[CatalogItem(id=i.id, descriptor=Descriptor(name=i.name), tags=i.attributes, match_reason=reason)
                   for i, reason in matched],
        )])
        body = OnSearchRequest(context=ctx, message=OnSearchMessage(catalog=catalog)).model_dump()
        print(f"  [ADAPTER] on_search -> POST {req.context.bap_uri}/on_search (mediating: {provider.id})")
        await _post(req.context.bap_uri, "/on_search", body)
    if not any_matched:
        print(f"  [ADAPTER] nothing relevant among mediated participants -- staying silent.")


@app.post("/search", response_model=AckResponse)
async def search(req: SearchRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(_do_on_search, req)
    return ack(req.context)


@app.post("/select", response_model=AckResponse)
async def select(req: OrderRequest):
    provider = _providers_by_id.get(req.context.bpp_id)
    if provider is None:
        return nack(req.context, code="40004", message=f"this adapter does not mediate '{req.context.bpp_id}'")
    if provider.participation_type == "discovery_only":
        print(f"  [ADAPTER] NACK -- {provider.id} is discovery-only, cannot process 'select'.")
        return nack(req.context, code="30001",
                    message="This provider is discovery-only. Contact them directly to proceed.")
    if not req.message.order.items:
        return nack(req.context, code="40000", message="order.items must not be empty.")
    item_id = req.message.order.items[0].id
    if not any(i.id == item_id for i in provider.items):
        return nack(req.context, code="40001", message=f"No such item '{item_id}'.")

    tx_id = req.context.transaction_id
    _pending[tx_id] = {"context": req.context, "item_id": item_id, "provider_id": provider.id}
    _orders[tx_id] = {"provider": {"id": provider.id}, "items": [{"id": item_id}], "status": "PENDING"}
    _bap_uri_by_tx[tx_id] = req.context.bap_uri
    print(f"  [ADAPTER] select for {provider.id} queued as PENDING.")
    return ack(req.context)


@app.get("/provider/pending")
def list_pending():
    return [{"tx_id": tx_id, "item_id": v["item_id"], "provider_id": v["provider_id"]} for tx_id, v in _pending.items()]


@app.post("/provider/pending/{tx_id}/accept")
async def accept_pending(tx_id: str):
    entry = _pending.pop(tx_id, None)
    if entry is None:
        raise HTTPException(404, "no pending request with this transaction id")
    ctx = entry["context"]
    provider = _providers_by_id[entry["provider_id"]]
    item = next(i for i in provider.items if i.id == entry["item_id"])
    order = Order(provider=OrderProviderRef(id=provider.id), items=[{"id": item.id}],
                  quote=item.attributes, status="QUOTED")
    _orders[tx_id] = order.model_dump()
    on_ctx = ctx.for_callback("on_select", provider.id, SELF_URL)
    await _post(ctx.bap_uri, "/on_select", OnOrderRequest(context=on_ctx, message=OrderMessage(order=order)).model_dump())
    return {"status": "accepted"}


@app.post("/provider/pending/{tx_id}/decline")
async def decline_pending(tx_id: str, reason: str = "Not available right now."):
    entry = _pending.pop(tx_id, None)
    if entry is None:
        raise HTTPException(404, "no pending request with this transaction id")
    ctx = entry["context"]
    provider = _providers_by_id[entry["provider_id"]]
    order = Order(provider=OrderProviderRef(id=provider.id), items=[{"id": entry["item_id"]}],
                  status="DECLINED", decline_reason=reason)
    _orders[tx_id] = order.model_dump()
    on_ctx = ctx.for_callback("on_select", provider.id, SELF_URL)
    await _post(ctx.bap_uri, "/on_select", OnOrderRequest(context=on_ctx, message=OrderMessage(order=order)).model_dump())
    return {"status": "declined"}


async def _do_on_order(action: str, req: OrderRequest) -> None:
    on_action = f"on_{action}"
    provider = _providers_by_id[req.context.bpp_id]
    ctx = req.context.for_callback(on_action, provider.id, SELF_URL)
    order = req.message.order
    if action == "init":
        order = order.model_copy(update={"status": "INITIATED"})
    elif action == "confirm":
        order = order.model_copy(update={"id": f"{provider.id}-{req.context.transaction_id}", "status": "RESERVED"})
    _orders[req.context.transaction_id] = order.model_dump()
    _bap_uri_by_tx[req.context.transaction_id] = req.context.bap_uri
    await _post(req.context.bap_uri, f"/{on_action}", OnOrderRequest(context=ctx, message=OrderMessage(order=order)).model_dump())


def _order_endpoint(action: str):
    async def handler(req: OrderRequest, background_tasks: BackgroundTasks):
        provider = _providers_by_id.get(req.context.bpp_id)
        if provider is None:
            return nack(req.context, code="40004", message=f"this adapter does not mediate '{req.context.bpp_id}'")
        if provider.participation_type == "discovery_only":
            return nack(req.context, code="30001",
                        message="This provider is discovery-only. Contact them directly to proceed.")
        background_tasks.add_task(_do_on_order, action, req)
        return ack(req.context)
    return handler


app.post("/init", response_model=AckResponse)(_order_endpoint("init"))
app.post("/confirm", response_model=AckResponse)(_order_endpoint("confirm"))


@app.get("/provider/commitments")
def list_commitments():
    return [{"tx_id": tx_id, **o} for tx_id, o in _orders.items() if o.get("status") == "RESERVED"]


@app.post("/provider/commitments/{tx_id}/fulfil")
async def fulfil(tx_id: str, note: str = "Support delivered."):
    order = _orders.get(tx_id)
    if order is None or order.get("status") != "RESERVED":
        raise HTTPException(400, "no RESERVED commitment with this transaction id")
    order = {**order, "status": "FULFILLED", "fulfilment_note": note}
    _orders[tx_id] = order
    bap_uri = _bap_uri_by_tx.get(tx_id)
    provider_id = order["provider"]["id"]
    ctx_payload = {
        "domain": ngo_support.DOMAIN, "action": "on_fulfil", "bap_id": "nfh-bap-v2", "bap_uri": bap_uri,
        "bpp_id": provider_id, "bpp_uri": SELF_URL, "transaction_id": tx_id,
    }
    if bap_uri:
        await _post(bap_uri, "/on_fulfil", {"context": ctx_payload, "message": {"order": order}})
    return {"status": "fulfilled"}


@app.post("/on_verify")
def on_verify(payload: dict):
    tx_id = payload.get("context", {}).get("transaction_id")
    if tx_id in _orders:
        _orders[tx_id]["status"] = "VERIFIED"
    return {"status": "noted"}


@app.get("/provider/history")
def list_history():
    return [{"tx_id": tx_id, **o} for tx_id, o in _orders.items() if o.get("status") in ("FULFILLED", "VERIFIED")]
