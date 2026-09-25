"""
Registry service -- identical role to real_protocol/registry.py (a real
HTTP subscriber directory), copied into network_v2 so this system never
imports from or modifies the existing one. Runs on its own port so it
can be up at the same time as the original.

    uvicorn network_v2.registry:app --port 9501

Closes three gaps found by inspecting the running system (no governance,
no network name, no way to register a Gateway or a node holding more
than one role):

  - GET /policy -- the network previously had no declared name or
    operator anywhere. This is the one place that answer now lives,
    env-var configurable, with honest "not yet decided" placeholders
    rather than an invented answer.
  - Subscriber.types is now a *list*, not a single value -- so a node
    can hold more than one role (e.g. a future node that is both a BAP
    and a BPP -- Appendix B's "hybrid" participation, which the old
    single-value field made impossible to express).
  - Subscriber.domain is now optional -- a BAP asks across every domain
    it supports, and the Gateway (see the new "BG" registration in
    serve.py) isn't domain-scoped at all; only a BPP's catalog is
    genuinely tied to one domain. None means "not scoped to one domain."
"""
import os
from typing import Literal, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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

# ---- Network identity / governance ----------------------------------------
# Real Beckn networks publish a "Network Policy" naming who operates the
# network and what participants must agree to join. This system had
# neither anywhere -- no field, no config, no constant. Read from
# environment variables so a real answer can be supplied without
# touching code; the defaults are deliberately honest placeholders, not
# an invented governance body.
NETWORK_NAME = os.environ.get("NETWORK_NAME", "(network name not yet decided)")
NETWORK_OPERATOR = os.environ.get("NETWORK_OPERATOR", "(governance not yet decided)")
NETWORK_OPERATOR_CONTACT = os.environ.get("NETWORK_OPERATOR_CONTACT", "")
NETWORK_DESCRIPTION = os.environ.get(
    "NETWORK_DESCRIPTION",
    "Prototype Beckn-style network for Bana Pele ECD services (ngo-support, coaching).",
)


class Subscriber(BaseModel):
    subscriber_id: str
    url: str
    domain: Optional[str] = None
    types: list[Literal["BAP", "BPP", "BG"]] = Field(min_length=1)
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


@app.get("/policy")
def policy():
    """Answers 'what is this network called and who runs it' -- the gap
    found when nothing anywhere declared either. Everything here is
    env-var configurable; see the module docstring for why the defaults
    are placeholders rather than a made-up answer."""
    return {
        "network_name": NETWORK_NAME,
        "operator": NETWORK_OPERATOR,
        "operator_contact": NETWORK_OPERATOR_CONTACT,
        "description": NETWORK_DESCRIPTION,
        "domains": sorted({s.domain for s in _subscribers.values() if s.domain}),
        "participant_count": len(_subscribers),
    }


@app.post("/subscribe")
def subscribe(sub: Subscriber):
    _subscribers[sub.subscriber_id] = sub
    print(f"[REGISTRY-v2] subscribed {sub.subscriber_id} "
          f"({'/'.join(sub.types)}, domain={sub.domain or 'all'}, participation={sub.participation_type})")
    return {"status": "SUBSCRIBED", "subscriber_id": sub.subscriber_id}


@app.get("/lookup")
def lookup(domain: str, type: Optional[str] = None):
    return [s for s in _subscribers.values()
            if (s.domain is None or s.domain == domain) and (type is None or type in s.types)]
