"""
Message schemas for network_v2 -- a fork of real_protocol/schemas.py that
extends the transaction lifecycle to match Appendix B of the Digital
Backbone doc more closely:

  real_protocol:  select -> init -> confirm                (ends at CONFIRMED)
  network_v2:     select -> init -> confirm -> fulfil -> verify
                  (QUOTED -> INITIATED -> RESERVED -> FULFILLED -> VERIFIED)

Two other additions, both named directly in the doc:
  - select can now be *declined* by a full-transaction provider (not just
    NACKed synchronously by a discovery-only one) -- "The Thabo reviews...
    accepts, declines..." (UC2 narrative, section 9.2).
  - a minimal real consent grant (section 5) -- purpose + scope + a ref
    threaded through select, not a UI-only stub.

This file does not modify or import real_protocol/schemas.py -- it is a
self-contained copy so network_v2 never touches the existing system.
"""
from datetime import datetime, timezone
from typing import Any, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

Action = Literal[
    "search", "on_search",
    "select", "on_select",
    "init", "on_init",
    "confirm", "on_confirm",
    "fulfil", "on_fulfil",
    "verify", "on_verify",
]

OrderStatus = Literal[
    "PENDING", "QUOTED", "DECLINED", "INITIATED", "RESERVED", "FULFILLED", "VERIFIED",
]


def new_message_id() -> str:
    return str(uuid4())[:8]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Context(BaseModel):
    domain: str
    country: str = "ZAF"
    city: str = "std:013"
    core_version: str = "1.1.0"
    action: Action
    bap_id: str
    bap_uri: str
    bpp_id: Optional[str] = None
    bpp_uri: Optional[str] = None
    transaction_id: str
    message_id: str = Field(default_factory=new_message_id)
    timestamp: str = Field(default_factory=now_iso)
    ttl: str = "PT30S"
    # Not in real Beckn Core -- a lightweight, non-authenticated "who is
    # asking" so the network has a real named actor instead of an
    # anonymous BAP. Real identity/auth is explicitly out of scope here.
    participant_name: Optional[str] = None

    def for_callback(self, action: Action, bpp_id: str, bpp_uri: str) -> "Context":
        return self.model_copy(update={
            "action": action, "bpp_id": bpp_id, "bpp_uri": bpp_uri,
            "message_id": new_message_id(), "timestamp": now_iso(),
        })

    def for_direct_call(self, action: Action, bpp_id: str, bpp_uri: str) -> "Context":
        return self.model_copy(update={
            "action": action, "bpp_id": bpp_id, "bpp_uri": bpp_uri,
            "message_id": new_message_id(), "timestamp": now_iso(),
        })


class AckBody(BaseModel):
    status: Literal["ACK", "NACK"]


class ErrorBody(BaseModel):
    code: str
    message: str


class AckMessage(BaseModel):
    ack: AckBody


class AckResponse(BaseModel):
    context: Context
    message: AckMessage
    error: Optional[ErrorBody] = None


def ack(context: Context) -> AckResponse:
    return AckResponse(context=context, message=AckMessage(ack=AckBody(status="ACK")))


def nack(context: Context, code: str, message: str) -> AckResponse:
    return AckResponse(context=context, message=AckMessage(ack=AckBody(status="NACK")),
                        error=ErrorBody(code=code, message=message))


# ---- search / on_search ----

class Descriptor(BaseModel):
    name: str
    short_desc: Optional[str] = None


class Intent(BaseModel):
    category: Optional[Descriptor] = None
    tags: dict[str, Any] = Field(default_factory=dict)


class SearchMessage(BaseModel):
    intent: Intent


class SearchRequest(BaseModel):
    context: Context
    message: SearchMessage


class CatalogItem(BaseModel):
    id: str
    descriptor: Descriptor
    tags: dict[str, Any] = Field(default_factory=dict)
    # Not in real Beckn -- a short, honest "why this matched" string
    # (B3's "Match or response... fit explanation"), computed once by the
    # provider that matched it, not invented client-side.
    match_reason: Optional[str] = None


class CatalogProvider(BaseModel):
    id: str
    descriptor: Descriptor
    participation_type: Literal["discovery_only", "full_transaction"]
    items: list[CatalogItem] = Field(default_factory=list)


class Catalog(BaseModel):
    providers: list[CatalogProvider] = Field(default_factory=list)


class OnSearchMessage(BaseModel):
    catalog: Catalog


class OnSearchRequest(BaseModel):
    context: Context
    message: OnSearchMessage


# ---- select / init / confirm / fulfil / verify (and their on_* replies) ----
# All share the same message.order shape, per real Beckn.

class OrderProviderRef(BaseModel):
    id: str


class OrderItemRef(BaseModel):
    id: str
    quantity: Optional[dict[str, Any]] = None


class Order(BaseModel):
    id: Optional[str] = None
    provider: OrderProviderRef
    items: list[OrderItemRef] = Field(default_factory=list)
    quote: Optional[dict[str, Any]] = None
    status: Optional[OrderStatus] = None
    decline_reason: Optional[str] = None
    fulfilment_note: Optional[str] = None
    verification_method: Optional[str] = None


class OrderMessage(BaseModel):
    order: Order


class OrderRequest(BaseModel):
    context: Context
    message: OrderMessage


class OnOrderRequest(BaseModel):
    context: Context
    message: OrderMessage


# ---- consent (section 5) -- minimal but real, not a UI-only stub ----

class ConsentGrantRequest(BaseModel):
    participant_name: str
    purpose: str
    scope: list[str] = Field(default_factory=list)
    provider_id: Optional[str] = None


class ConsentGrant(BaseModel):
    consent_ref: str
    participant_name: str
    purpose: str
    scope: list[str]
    provider_id: Optional[str] = None
    granted_at: str = Field(default_factory=now_iso)
