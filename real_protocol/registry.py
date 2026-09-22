"""
Registry service -- real HTTP subscriber directory, analogous to the
Beckn DeDi Registry. Never transacts; only answers "who serves this
domain". Run standalone:

    uvicorn real_protocol.registry:app --port 9001
"""
from typing import Literal, Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Registry")


class Subscriber(BaseModel):
    subscriber_id: str
    url: str
    domain: str
    type: Literal["BAP", "BPP", "BG"]
    participation_type: Optional[Literal["discovery_only", "full_transaction"]] = None


_subscribers: dict[str, Subscriber] = {}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/subscribe")
def subscribe(sub: Subscriber):
    _subscribers[sub.subscriber_id] = sub
    print(f"[REGISTRY] subscribed {sub.subscriber_id} "
          f"({sub.type}, domain={sub.domain}, participation={sub.participation_type})")
    return {"status": "SUBSCRIBED", "subscriber_id": sub.subscriber_id}


@app.get("/lookup")
def lookup(domain: str, type: Optional[str] = None):
    return [s for s in _subscribers.values()
            if s.domain == domain and (type is None or s.type == type)]
