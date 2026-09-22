"""
Real HTTP API in front of the existing in-process Beckn simulation.

This file only imports and orchestrates Registry / Gateway / BAP / BPP from
shared/network.py -- it does not change any protocol logic there. The only
"instrumentation" trick used is wrapping a session's Gateway instance methods
(broadcast_discover / route) so every real Message that crosses the network
boundary gets appended to that session's log -- the messages themselves are
the exact objects shared/network.py builds and returns.

Run:
    python3 api.py
    # or: uvicorn api:app --reload --port 8000
"""
import dataclasses
import uuid
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from domains import coaching, ngo_support
from shared.models import Intent, Message
from shared.network import BAP, BPP, Gateway, Registry

app = FastAPI(title="Beckn Network Prototype API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DOMAIN_MODULES = {
    "ngo-support": ngo_support,
    "coaching": coaching,
}


def to_jsonable(value: Any) -> Any:
    """Recursively turn dataclasses (Context, Message, ...) and nested
    dict/list structures into plain JSON-serialisable data, without
    mutating or reaching into shared/network.py's classes."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: to_jsonable(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    return value


def message_to_dict(msg: Message) -> dict:
    return {
        "context": to_jsonable(msg.context),
        "payload": to_jsonable(msg.payload),
    }


class SessionState:
    """Holds one live network + the running log of everything exchanged
    on it. One instance per browser session."""

    def __init__(self, session_id: str, domain: str):
        self.id = session_id
        self.domain = domain
        self.registry = Registry()
        self.gateway = Gateway(self.registry)
        self.bap = BAP(f"bap-{session_id[:8]}", self.gateway)
        self.nodes: list[dict] = []
        self.log: list[dict] = []
        # last on_discover Message received from each bpp_id -- needed to
        # build the select() call, which takes the on_discover message.
        self.on_discover_by_bpp: dict[str, Message] = {}
        # last reply in the select -> init -> confirm chain, per bpp_id.
        self.chain_by_bpp: dict[str, Message] = {}
        self._instrument_gateway()

    def _instrument_gateway(self):
        """Wrap the real Gateway methods (not edit them) so every request
        and response Message that actually crosses the network is logged."""
        original_broadcast = self.gateway.broadcast_discover
        original_route = self.gateway.route

        async def broadcast_discover(discover_msg: Message):
            self._log("request", discover_msg)
            responses = await original_broadcast(discover_msg)
            for r in responses:
                self._log("response", r)
            return responses

        async def route(msg: Message):
            self._log("request", msg)
            reply = await original_route(msg)
            self._log("response", reply)
            return reply

        self.gateway.broadcast_discover = broadcast_discover
        self.gateway.route = route

    def _log(self, direction: str, msg: Message):
        self.log.append({
            "seq": len(self.log),
            "direction": direction,
            **message_to_dict(msg),
        })


SESSIONS: dict[str, SessionState] = {}


def get_session(session_id: str) -> SessionState:
    state = SESSIONS.get(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"unknown session_id '{session_id}'")
    return state


# ---------------------------------------------------------------- /session

class SessionCreateRequest(BaseModel):
    domain: Literal["ngo-support", "coaching"]


@app.post("/session")
def create_session(req: SessionCreateRequest):
    module = DOMAIN_MODULES[req.domain]
    session_id = str(uuid.uuid4())
    state = SessionState(session_id, module.DOMAIN)

    for provider in module.build_providers():
        state.registry.register(provider, module.DOMAIN)
        state.gateway.attach(BPP(provider))
        state.nodes.append({
            "id": provider.id,
            "name": provider.name,
            "participation_type": provider.participation_type,
        })

    SESSIONS[session_id] = state
    return {
        "session_id": session_id,
        "domain": state.domain,
        "bap_id": state.bap.bap_id,
        "nodes": state.nodes,
        "sample_intent": to_jsonable(module.SAMPLE_INTENT),
    }


# -------------------------------------------------------------- /discover

class DiscoverRequest(BaseModel):
    intent: dict = Field(..., description='{"category": str, "attributes": {...}}')


@app.post("/session/{session_id}/discover")
async def discover(session_id: str, req: DiscoverRequest):
    state = get_session(session_id)
    intent = Intent(
        category=req.intent.get("category", ""),
        attributes=req.intent.get("attributes", {}) or {},
    )
    responses = await state.bap.discover(state.domain, intent)
    for r in responses:
        state.on_discover_by_bpp[r.context.bpp_id] = r
    return {"on_discover": [message_to_dict(r) for r in responses]}


# ---------------------------------------------------------------- /select

class SelectRequest(BaseModel):
    bpp_id: str
    item_id: str


@app.post("/session/{session_id}/select")
async def select(session_id: str, req: SelectRequest):
    state = get_session(session_id)
    on_discover_msg = state.on_discover_by_bpp.get(req.bpp_id)
    if on_discover_msg is None:
        raise HTTPException(status_code=400, detail=f"no on_discover from '{req.bpp_id}' yet -- call /discover first")
    reply = await state.bap.select(on_discover_msg, req.item_id)
    state.chain_by_bpp[req.bpp_id] = reply
    return message_to_dict(reply)


# ------------------------------------------------------------ /init /confirm

class ChainRequest(BaseModel):
    bpp_id: str


@app.post("/session/{session_id}/init")
async def init(session_id: str, req: ChainRequest):
    state = get_session(session_id)
    prior = state.chain_by_bpp.get(req.bpp_id)
    if prior is None:
        raise HTTPException(status_code=400, detail=f"no select() reply for '{req.bpp_id}' yet -- call /select first")
    if prior.payload.get("error"):
        raise HTTPException(status_code=409, detail="prior step was rejected (discovery-only node) -- cannot continue")
    reply = await state.bap.init(prior)
    state.chain_by_bpp[req.bpp_id] = reply
    return message_to_dict(reply)


@app.post("/session/{session_id}/confirm")
async def confirm(session_id: str, req: ChainRequest):
    state = get_session(session_id)
    prior = state.chain_by_bpp.get(req.bpp_id)
    if prior is None:
        raise HTTPException(status_code=400, detail=f"no init() reply for '{req.bpp_id}' yet -- call /init first")
    if prior.payload.get("error"):
        raise HTTPException(status_code=409, detail="prior step was rejected (discovery-only node) -- cannot continue")
    reply = await state.bap.confirm(prior)
    state.chain_by_bpp[req.bpp_id] = reply
    return message_to_dict(reply)


# ------------------------------------------------------------------- /log

@app.get("/session/{session_id}/log")
def get_log(session_id: str):
    state = get_session(session_id)
    return {"log": state.log}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
