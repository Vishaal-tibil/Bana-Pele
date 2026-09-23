"""
Registry service -- identical role to real_protocol/registry.py (a real
HTTP subscriber directory), copied into network_v2 so this system never
imports from or modifies the existing one. Runs on its own port so it
can be up at the same time as the original.

    uvicorn network_v2.registry:app --port 9501
"""
from typing import Literal, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Registry (network_v2)")

# Nothing browser-facing called this node directly before -- the Network
# Console does, straight to this port, so a viewer's own browser devtools
# can see the request/response, not just take the app's word for it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:9503", "http://127.0.0.1:9503"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Subscriber(BaseModel):
    subscriber_id: str
    url: str
    domain: str
    type: Literal["BAP", "BPP", "BG"]
    participation_type: Optional[Literal["discovery_only", "full_transaction"]] = None
    # Appendix B2's other axis -- orthogonal to participation_type above.
    # "independent": runs its own process at `url`. "platform_mediated":
    # `url` belongs to a shared adapter (e.g. the My Journey Network
    # Adapter) publishing and answering on this subscriber's behalf --
    # see network_v2/journey_adapter.py. Explicit, not inferred, so a
    # viewer doesn't have to guess it from which port a subscriber uses.
    participation_pattern: Literal["independent", "platform_mediated"] = "independent"


_subscribers: dict[str, Subscriber] = {}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/subscribe")
def subscribe(sub: Subscriber):
    _subscribers[sub.subscriber_id] = sub
    print(f"[REGISTRY-v2] subscribed {sub.subscriber_id} "
          f"({sub.type}, domain={sub.domain}, participation={sub.participation_type})")
    return {"status": "SUBSCRIBED", "subscriber_id": sub.subscriber_id}


@app.get("/lookup")
def lookup(domain: str, type: Optional[str] = None):
    return [s for s in _subscribers.values()
            if s.domain == domain and (type is None or s.type == type)]
