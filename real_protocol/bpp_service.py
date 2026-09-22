"""
BPP service -- one real HTTP process per provider. Speaks real Beckn
actions, ACKs synchronously, then calls back to the requester's own
bap_uri asynchronously with the actual content -- the two-step pattern
shared/network.py's BPP class collapses into a single return value.

discovery_only providers NACK select/init/confirm synchronously (there is
nothing to fulfil over the network) instead of ever reaching on_*.

on_search does real relevance matching against the intent (see
`_matching_items` below) -- a provider with nothing relevant simply never
calls back, same as it would for real, instead of every provider always
returning its whole catalog regardless of what was searched.

Which provider (and which domain's catalog) this process serves is picked
by env vars, so the same file is the service for every provider in every
wired-up domain -- one process each:

    BPP_ID=smartstart BPP_PORT=9101 BPP_DOMAIN=ngo-support \\
        uvicorn real_protocol.bpp_service:app --port 9101
"""
import os

import httpx
from fastapi import BackgroundTasks, FastAPI

from domains import coaching, ngo_support
from real_protocol.schemas import (
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

app = FastAPI(title=f"BPP:{PROVIDER_ID}")


def _matching_items(intent):
    """Real (if simple) relevance matching: an empty search matches
    everything (browse-all); otherwise the free-text query must appear in
    the item's id/name/attribute values, and -- if given -- the region tag
    must appear in the item's own 'region' attribute. Returns only the
    items that matched, so a provider with none can decline to answer."""
    query = (intent.category.name if intent.category else "").strip().lower()
    region = str(intent.tags.get("region") or "").strip().lower()

    def matches(item):
        if query:
            haystack = " ".join(
                [item.id, item.name, *(str(v) for v in item.attributes.values())]
            ).lower()
            if query not in haystack:
                return False
        if region and region not in str(item.attributes.get("region", "")).lower():
            return False
        return True

    return [i for i in _provider.items if matches(i)]


@app.get("/health")
def health():
    return {"status": "ok", "provider": PROVIDER_ID}


async def _post(url: str, path: str, body: dict) -> None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            await client.post(f"{url}{path}", json=body)
        except httpx.HTTPError as exc:
            print(f"  [BPP:{PROVIDER_ID}] callback to {url}{path} failed: {exc}")


async def _do_on_search(req: SearchRequest) -> None:
    matched = _matching_items(req.message.intent)
    if not matched:
        print(f"  [BPP:{PROVIDER_ID}] nothing relevant to this search -- staying silent, no on_search sent.")
        return
    ctx = req.context.for_callback("on_search", PROVIDER_ID, SELF_URL)
    catalog = Catalog(providers=[CatalogProvider(
        id=_provider.id,
        descriptor=Descriptor(name=_provider.name),
        participation_type=_provider.participation_type,
        items=[CatalogItem(id=i.id, descriptor=Descriptor(name=i.name), tags=i.attributes)
               for i in matched],
    )])
    body = OnSearchRequest(context=ctx, message=OnSearchMessage(catalog=catalog)).model_dump()
    print(f"  [BPP:{PROVIDER_ID}] on_search -> POST {req.context.bap_uri}/on_search "
          f"({len(matched)}/{len(_provider.items)} item(s) matched, {_provider.participation_type})")
    await _post(req.context.bap_uri, "/on_search", body)


@app.post("/search", response_model=AckResponse)
async def search(req: SearchRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(_do_on_search, req)
    return ack(req.context)


async def _do_on_order(action: str, req: OrderRequest) -> None:
    on_action = f"on_{action}"
    ctx = req.context.for_callback(on_action, PROVIDER_ID, SELF_URL)
    order = req.message.order
    if action == "select":
        item = next(i for i in _provider.items if i.id == order.items[0].id)
        order = order.model_copy(update={"quote": item.attributes, "status": "QUOTED"})
    elif action == "init":
        order = order.model_copy(update={"status": "INITIATED"})
    elif action == "confirm":
        order = order.model_copy(update={
            "id": f"{PROVIDER_ID}-{req.context.transaction_id}", "status": "CONFIRMED",
        })
    body = OnOrderRequest(context=ctx, message=OrderMessage(order=order)).model_dump()
    print(f"  [BPP:{PROVIDER_ID}] {on_action} -> POST {req.context.bap_uri}/{on_action}")
    await _post(req.context.bap_uri, f"/{on_action}", body)


def _order_endpoint(action: str):
    async def handler(req: OrderRequest, background_tasks: BackgroundTasks):
        if _provider.participation_type == "discovery_only":
            print(f"  [BPP:{PROVIDER_ID}] NACK -- discovery-only, cannot process '{action}'. "
                  f"Fulfilment happens outside the network.")
            return nack(req.context, code="30001",
                        message="This provider is discovery-only. Contact them directly to proceed.")
        if action == "select":
            if not req.message.order.items:
                return nack(req.context, code="40000", message="order.items must not be empty.")
            item_id = req.message.order.items[0].id
            if not any(i.id == item_id for i in _provider.items):
                print(f"  [BPP:{PROVIDER_ID}] NACK -- unknown item '{item_id}'.")
                return nack(req.context, code="40001", message=f"No such item '{item_id}'.")
        background_tasks.add_task(_do_on_order, action, req)
        return ack(req.context)
    return handler


app.post("/select", response_model=AckResponse)(_order_endpoint("select"))
app.post("/init", response_model=AckResponse)(_order_endpoint("init"))
app.post("/confirm", response_model=AckResponse)(_order_endpoint("confirm"))
