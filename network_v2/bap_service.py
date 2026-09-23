"""
BAP service for network_v2 -- same role as real_protocol/bap_service.py
(the one node a client talks to), extended with:

  - consent (section 5): a real minimal grant + ref, not a UI-only stub
  - participant_name carried through the Context (section 9.4's
    "Participant access and role context")
  - two more lifecycle actions past confirm: verify (client-facing) and
    the on_fulfil webhook a BPP calls once it marks something delivered
  - it also serves the two static webapps (Naledi + Provider) directly,
    same pattern the downloaded UC1/UC2 prototype's own main.py uses, so
    there's exactly one thing to run and one port to open in a browser.

Client-facing endpoints (not part of the Beckn spec -- "our app's API"):
    GET  /naledi, /provider, /              -- the two webapps + landing
    GET  /client/providers?domain=...
    POST /client/consent                     {participant_name, purpose, scope, provider_id?}
    POST /client/search   {domain, category, region, participant_name}
    GET  /client/results/{tx_id}
    POST /client/select   {tx_id, bpp_id, item_id, consent_ref?}
    POST /client/init     {tx_id, bpp_id}
    POST /client/confirm  {tx_id, bpp_id}
    POST /client/verify   {tx_id, bpp_id, verification_method?}
    GET  /client/order/{tx_id}
    GET  /client/log/{tx_id}
"""
import os
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from network_v2.schemas import (
    Context, ConsentGrant, Descriptor, Intent, OnOrderRequest, OnSearchRequest,
    Order, OrderMessage, OrderProviderRef, OrderRequest, SearchMessage, SearchRequest,
)

BAP_ID = "nfh-bap-v2"
PORT = int(os.environ.get("BAP_PORT", 9503))
SELF_URL = f"http://127.0.0.1:{PORT}"
GATEWAY_URL = "http://127.0.0.1:9502"
REGISTRY_URL = "http://127.0.0.1:9501"
WEBAPP_DIR = Path(__file__).resolve().parent / "webapp"

app = FastAPI(title="BAP (network_v2)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:9503", "http://127.0.0.1:9503"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# tx_id -> {"domain", "participant_name", "results": [...], "order": {...}, "log": [...], "bpp_uri"}
_transactions: dict[str, dict] = {}
# consent_ref -> ConsentGrant
_consents: dict[str, ConsentGrant] = {}


@app.get("/health")
def health():
    return {"status": "ok"}


# ---- static webapps ----

@app.get("/")
def serve_landing():
    return FileResponse(WEBAPP_DIR / "landing.html")


@app.get("/naledi")
def serve_naledi():
    return FileResponse(WEBAPP_DIR / "naledi.html")


@app.get("/provider")
def serve_provider():
    return FileResponse(WEBAPP_DIR / "provider.html")


@app.get("/network")
def serve_network():
    """The Network Console -- a third tab that talks directly to Registry,
    Gateway and every BPP's own port (not proxied through this BAP), so
    the browser's own requests are the proof the network is real."""
    return FileResponse(WEBAPP_DIR / "network.html")


@app.get("/live")
def serve_live():
    """Both webapps side by side in one screen (each in its own iframe,
    same origin, no special wiring) -- so one person can drive Naledi's
    request on one side and accept/decline/fulfil it on the other without
    switching tabs, watching the same real HTTP calls either way."""
    return FileResponse(WEBAPP_DIR / "live.html")


# ---- helpers ----

def _log(tx_id: str, direction: str, note: str, payload: dict) -> None:
    _transactions[tx_id]["log"].append({"direction": direction, "note": note, "payload": payload})


def _new_context(action: str, domain: str, tx_id: str, participant_name: str = None,
                  bpp_id: str = None, bpp_uri: str = None) -> Context:
    return Context(domain=domain, action=action, bap_id=BAP_ID, bap_uri=SELF_URL,
                   bpp_id=bpp_id, bpp_uri=bpp_uri, transaction_id=tx_id,
                   participant_name=participant_name)


# ---- discovery ----

@app.get("/client/providers")
async def client_providers(domain: str):
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{REGISTRY_URL}/lookup", params={"domain": domain, "type": "BPP"})
        resp.raise_for_status()
        return resp.json()


@app.post("/client/search")
async def client_search(domain: str, category: str = "", region: str = "", participant_name: str = "Naledi"):
    import uuid
    tx_id = str(uuid.uuid4())[:8]
    _transactions[tx_id] = {"domain": domain, "participant_name": participant_name,
                             "results": [], "order": None, "log": [], "bpp_uri": None}
    ctx = _new_context("search", domain, tx_id, participant_name=participant_name)
    intent = Intent(category=Descriptor(name=category), tags={"region": region})
    req = SearchRequest(context=ctx, message=SearchMessage(intent=intent))
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(f"{GATEWAY_URL}/search", json=req.model_dump())
        resp.raise_for_status()
    _log(tx_id, "sent", "search -> gateway", req.model_dump())
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


@app.get("/client/transactions")
def client_transactions():
    """Every transaction this BAP process has touched since it started --
    not part of the Beckn spec, a debug/observability view for the
    Network Console so a viewer can see live activity from any tab."""
    return [
        {
            "tx_id": tx_id,
            "domain": tx["domain"],
            "participant_name": tx["participant_name"],
            "providers_answered": len(tx["results"]),
            "order_status": (tx["order"] or {}).get("status"),
            "message_count": len(tx["log"]),
        }
        for tx_id, tx in _transactions.items()
    ]


# ---- consent (section 5) ----

@app.post("/client/consent")
def client_consent(body: dict):
    import uuid
    consent_ref = f"CNS-{uuid.uuid4().hex[:8]}"
    grant = ConsentGrant(
        consent_ref=consent_ref,
        participant_name=body.get("participant_name", "Naledi"),
        purpose=body.get("purpose", ""),
        scope=body.get("scope", []),
        provider_id=body.get("provider_id"),
    )
    _consents[consent_ref] = grant
    return grant.model_dump()


# ---- transaction actions ----

async def _client_order_action(action: str, tx_id: str, bpp_id: str,
                                item_id: str = None, consent_ref: str = None):
    if tx_id not in _transactions:
        raise HTTPException(404, "unknown transaction")
    tx = _transactions[tx_id]
    if consent_ref and consent_ref not in _consents:
        raise HTTPException(403, f"consent_ref '{consent_ref}' not found -- grant consent before selecting")

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

    context = _new_context(action, tx["domain"], tx_id, participant_name=tx["participant_name"],
                            bpp_id=bpp_id, bpp_uri=bpp_uri)
    req = OrderRequest(context=context, message=OrderMessage(order=order))
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(f"{bpp_uri}/{action}", json=req.model_dump())
    body = resp.json()
    _log(tx_id, "sent", f"{action} -> {bpp_id}", req.model_dump())
    _log(tx_id, "received", f"ack from {bpp_id}", body)
    tx["bpp_uri"] = bpp_uri
    if body["message"]["ack"]["status"] == "NACK":
        return {"status": "NACK", "error": body["error"]}
    return {"status": "ACK"}


@app.post("/client/select")
async def client_select(tx_id: str, bpp_id: str, item_id: str, consent_ref: str = None):
    return await _client_order_action("select", tx_id, bpp_id, item_id=item_id, consent_ref=consent_ref)


@app.post("/client/init")
async def client_init(tx_id: str, bpp_id: str):
    return await _client_order_action("init", tx_id, bpp_id)


@app.post("/client/confirm")
async def client_confirm(tx_id: str, bpp_id: str):
    return await _client_order_action("confirm", tx_id, bpp_id)


@app.post("/client/verify")
async def client_verify(tx_id: str, bpp_id: str, verification_method: str = "participant_confirmed"):
    if tx_id not in _transactions:
        raise HTTPException(404, "unknown transaction")
    tx = _transactions[tx_id]
    if tx["order"] is None or tx["order"].get("status") != "FULFILLED":
        raise HTTPException(400, "order is not FULFILLED yet -- nothing to verify")
    tx["order"]["status"] = "VERIFIED"
    tx["order"]["verification_method"] = verification_method
    ctx = _new_context("verify", tx["domain"], tx_id, participant_name=tx["participant_name"],
                        bpp_id=bpp_id, bpp_uri=tx["bpp_uri"])
    _log(tx_id, "sent", f"verify -> {bpp_id}", {"context": ctx.model_dump(), "verification_method": verification_method})
    if tx["bpp_uri"]:
        async with httpx.AsyncClient(timeout=5.0) as client:
            try:
                await client.post(f"{tx['bpp_uri']}/on_verify",
                                   json={"context": ctx.model_dump(), "message": {"order": tx["order"]}})
            except httpx.HTTPError:
                pass
    return {"status": "VERIFIED", "order": tx["order"]}


@app.get("/client/order/{tx_id}")
def client_order(tx_id: str):
    if tx_id not in _transactions:
        raise HTTPException(404, "unknown transaction")
    return {"order": _transactions[tx_id]["order"]}


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
    _log(req.context.transaction_id, "received", f"on_search from {req.context.bpp_id}", req.model_dump())
    return {"status": "RECEIVED"}


async def _on_order(req: OnOrderRequest):
    tx = _transactions.get(req.context.transaction_id)
    if tx is None:
        return {"status": "ignored"}
    tx["order"] = req.message.order.model_dump()
    tx["bpp_uri"] = req.context.bpp_uri
    _log(req.context.transaction_id, "received", f"{req.context.action} from {req.context.bpp_id}", req.model_dump())
    return {"status": "RECEIVED"}


app.post("/on_select")(_on_order)
app.post("/on_init")(_on_order)
app.post("/on_confirm")(_on_order)
app.post("/on_fulfil")(_on_order)
