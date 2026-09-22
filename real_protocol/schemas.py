"""
Message schemas -- real Beckn Core context/action envelope shapes, not the
simplified dict-payload version in shared/models.py.

Faithful to the spec:
  - Context carries domain/country/city/core_version/action/bap_id/bap_uri/
    bpp_id/bpp_uri/transaction_id/message_id/timestamp/ttl.
  - Every sync response is just an Ack or Nack -- real content (catalog,
    order) arrives later via a POST to the caller's own /on_* endpoint.
  - select/init/confirm/on_select/on_init/on_confirm all wrap the same
    `message.order` shape, per spec, instead of each being a bespoke dict.

Still simplified vs. the actual Beckn JSON schemas: no schema-file
validation, no signing, fewer optional fields (no `fulfillment`,
`payment`, `quote.breakup`, etc.) -- enough structure to prove the
envelope and the async pattern are real, not a full spec implementation.
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
]


def new_message_id() -> str:
    return str(uuid4())[:8]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Context(BaseModel):
    domain: str
    country: str = "ZAF"
    city: str = "std:013"          # Mpumalanga area code, placeholder like real Beckn city codes
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

    def for_callback(self, action: Action, bpp_id: str, bpp_uri: str) -> "Context":
        """Build the context for this node's own on_* callback: same
        transaction, new message_id, this node's own bpp_id/bpp_uri."""
        return self.model_copy(update={
            "action": action, "bpp_id": bpp_id, "bpp_uri": bpp_uri,
            "message_id": new_message_id(), "timestamp": now_iso(),
        })

    def for_direct_call(self, action: Action, bpp_id: str, bpp_uri: str) -> "Context":
        """Build the context for a BAP->BPP direct call (select/init/confirm),
        once the BAP already knows which bpp_uri to talk to from on_search."""
        return self.model_copy(update={
            "action": action, "bpp_id": bpp_id, "bpp_uri": bpp_uri,
            "message_id": new_message_id(), "timestamp": now_iso(),
        })


# ---- Ack / Nack envelope -- the only thing a sync HTTP response ever carries ----

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


# ---- select / init / confirm / on_select / on_init / on_confirm ----
# All four share the same message.order shape in real Beckn.

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
    status: Optional[Literal["QUOTED", "INITIATED", "CONFIRMED"]] = None


class OrderMessage(BaseModel):
    order: Order


class OrderRequest(BaseModel):
    context: Context
    message: OrderMessage


class OnOrderRequest(BaseModel):
    context: Context
    message: OrderMessage
