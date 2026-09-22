"""
BAP service -- the one node a client (frontend, demo script) actually
talks to. Internally it speaks real Beckn context/action envelopes to the
Gateway and to BPPs directly, and exposes on_* webhook endpoints that
BPPs call back into asynchronously. Run standalone:

    uvicorn real_protocol.bap_service:app --port 9003

Client-facing endpoints (not part of the Beckn spec -- this is "our app's
API", same role frontend/src/api.ts talks to today):
    POST /client/search   {domain, category, region} -> {transaction_id}
    GET  /client/results/{transaction_id}             -> on_search results so far
    POST /client/select   {transaction_id, bpp_id, item_id}
    POST /client/init     {transaction_id, bpp_id}
    POST /client/confirm  {transaction_id, bpp_id}
    GET  /client/log/{transaction_id}                 -> every message sent/received
    GET  /client/providers?domain=...                 -> registered BPPs for a domain
                                                          (id + participation_type, from the
                                                          Registry -- lets a UI draw the node
                                                          list before any on_search arrives)
    GET  /client/order/{transaction_id}                -> current order state, updated as
                                                          on_select/on_init/on_confirm callbacks
                                                          land (None until the first one does)

Also carries CORS for the frontend dev origin -- the browser talks to this
service directly, same as it talked to api.py before.
"""
import os

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from real_protocol.schemas import (
    Context, Descriptor, Intent, OnOrderRequest, OnSearchRequest, Order,
    OrderMessage, OrderProviderRef, OrderRequest, SearchMessage, SearchRequest,
)

BAP_ID = "nfh-bap"
PORT = int(os.environ.get("BAP_PORT", 9003))
SELF_URL = f"http://127.0.0.1:{PORT}"
GATEWAY_URL = "http://127.0.0.1:9002"
REGISTRY_URL = "http://127.0.0.1:9001"

app = FastAPI(title="BAP")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# transaction_id -> {"domain", "results": [...], "order": {...}, "log": [...]}
_transactions: dict[str, dict] = {}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/client/providers")
async def client_providers(domain: str):
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{REGISTRY_URL}/lookup", params={"domain": domain, "type": "BPP"})
        resp.raise_for_status()
        return resp.json()


@app.get("/client/order/{tx_id}")
def client_order(tx_id: str):
    if tx_id not in _transactions:
        raise HTTPException(404, "unknown transaction")
    return {"order": _transactions[tx_id]["order"]}


def _log(tx_id: str, direction: str, note: str, payload: dict) -> None:
    _transactions[tx_id]["log"].append({"direction": direction, "note": note, "payload": payload})


def _new_context(action: str, domain: str, tx_id: str, bpp_id=None, bpp_uri=None) -> Context:
    return Context(domain=domain, action=action, bap_id=BAP_ID, bap_uri=SELF_URL,
                   bpp_id=bpp_id, bpp_uri=bpp_uri, transaction_id=tx_id)


# ---- client-facing ----

@app.post("/client/search")
async def client_search(domain: str, category: str, region: str = ""):
    import uuid
    tx_id = str(uuid.uuid4())[:8]
    _transactions[tx_id] = {"domain": domain, "results": [], "order": None, "log": []}
    ctx = _new_context("search", domain, tx_id)
    intent = Intent(category=Descriptor(name=category), tags={"region": region})
    req = SearchRequest(context=ctx, message=SearchMessage(intent=intent))
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(f"{GATEWAY_URL}/search", json=req.model_dump())
        resp.raise_for_status()
    _log(tx_id, "sent", "search -> gateway", req.model_dump())
    print(f"[BAP] search({domain}) tx={tx_id} -> ACK from gateway; awaiting on_search callbacks")
    return {"transaction_id": tx_id, "ack": resp.json()}


@app.get("/client/results/{tx_id}")
def client_results(tx_id: str):
    if tx_id not in _transactions:
        raise HTTPException(404, "unknown transaction")
    return _transactions[tx_id]["results"]


@app.get("/client/log/{tx_id}")
def client_log(tx_id: str):
    if tx_id not in _transactions:
        raise HTTPException(404, "unknown transaction")
    return _transactions[tx_id]["log"]


async def _client_order_action(action: str, tx_id: str, bpp_id: str, item_id: str | None = None):
    if tx_id not in _transactions:
        raise HTTPException(404, "unknown transaction")
    tx = _transactions[tx_id]
    if action == "select":
        result = next((r for r in tx["results"] if r["bpp_id"] == bpp_id), None)
        if result is None:
            raise HTTPException(400, f"no on_search result from {bpp_id} yet")
        bpp_uri = result["bpp_uri"]
        order = Order(provider=OrderProviderRef(id=bpp_id), items=[{"id": item_id}])
    else:
        if tx["order"] is None or tx["order"]["provider"]["id"] != bpp_id:
            raise HTTPException(400, f"no prior order state with {bpp_id} for '{action}'")
        bpp_uri = tx["bpp_uri"]
        order = Order(**tx["order"])

    context = Context(domain=tx["domain"], action=action, bap_id=BAP_ID, bap_uri=SELF_URL,
                       bpp_id=bpp_id, bpp_uri=bpp_uri, transaction_id=tx_id)
    req = OrderRequest(context=context, message=OrderMessage(order=order))
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(f"{bpp_uri}/{action}", json=req.model_dump())
    body = resp.json()
    _log(tx_id, "sent", f"{action} -> {bpp_id}", req.model_dump())
    _log(tx_id, "received", f"ack from {bpp_id}", body)
    tx["bpp_uri"] = bpp_uri
    if body["message"]["ack"]["status"] == "NACK":
        print(f"[BAP] {action}({bpp_id}) tx={tx_id} -> NACK: {body['error']['message']}")
        return {"status": "NACK", "error": body["error"]}
    print(f"[BAP] {action}({bpp_id}) tx={tx_id} -> ACK; awaiting on_{action} callback")
    return {"status": "ACK"}


@app.post("/client/select")
async def client_select(tx_id: str, bpp_id: str, item_id: str):
    return await _client_order_action("select", tx_id, bpp_id, item_id)


@app.post("/client/init")
async def client_init(tx_id: str, bpp_id: str):
    return await _client_order_action("init", tx_id, bpp_id)


@app.post("/client/confirm")
async def client_confirm(tx_id: str, bpp_id: str):
    return await _client_order_action("confirm", tx_id, bpp_id)


# ---- webhooks BPPs call back into ----

@app.post("/on_search")
async def on_search(req: OnSearchRequest):
    tx = _transactions.get(req.context.transaction_id)
    if tx is None:
        return {"status": "ignored"}
    for provider in req.message.catalog.providers:
        tx["results"].append({
            "bpp_id": req.context.bpp_id,
            "bpp_uri": req.context.bpp_uri,
            "provider": provider.model_dump(),
        })
    _log(req.context.transaction_id, "received", f"on_search from {req.context.bpp_id}",
         req.model_dump())
    print(f"[BAP] on_search callback from {req.context.bpp_id} (tx={req.context.transaction_id})")
    return {"status": "RECEIVED"}


async def _on_order(req: OnOrderRequest):
    tx = _transactions.get(req.context.transaction_id)
    if tx is None:
        return {"status": "ignored"}
    tx["order"] = req.message.order.model_dump()
    tx["bpp_uri"] = req.context.bpp_uri
    _log(req.context.transaction_id, "received",
         f"{req.context.action} from {req.context.bpp_id}", req.model_dump())
    print(f"[BAP] {req.context.action} callback from {req.context.bpp_id} "
          f"(tx={req.context.transaction_id}) -> order status={req.message.order.status}")
    return {"status": "RECEIVED"}


app.post("/on_select")(_on_order)
app.post("/on_init")(_on_order)
app.post("/on_confirm")(_on_order)
