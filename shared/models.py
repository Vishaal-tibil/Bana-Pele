"""
Shared message models -- the contract every node speaks.
Deliberately mirrors real Beckn v2 message shapes (context + message),
simplified for a working prototype rather than full protocol compliance.
"""
from dataclasses import dataclass, field
from typing import Optional, Literal
from datetime import datetime
import uuid

Action = Literal["discover", "on_discover", "select", "on_select",
                  "init", "on_init", "confirm", "on_confirm"]

ParticipationType = Literal["discovery_only", "full_transaction"]


@dataclass
class Context:
    """Every message carries this -- who, what action, which conversation."""
    action: Action
    domain: str
    transaction_id: str
    message_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    bap_id: Optional[str] = None
    bpp_id: Optional[str] = None
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def reply(self, action: Action, bpp_id: str) -> "Context":
        """Build the context for a response to this message."""
        return Context(action=action, domain=self.domain,
                        transaction_id=self.transaction_id,
                        bap_id=self.bap_id, bpp_id=bpp_id)


@dataclass
class Intent:
    """What the BAP is looking for -- structured, never raw text."""
    category: str
    attributes: dict = field(default_factory=dict)


@dataclass
class Item:
    """One thing a provider offers."""
    id: str
    name: str
    description: str = ""
    attributes: dict = field(default_factory=dict)


@dataclass
class Provider:
    """A BPP's catalog entry -- what it's offering right now."""
    id: str
    name: str
    participation_type: ParticipationType
    items: list = field(default_factory=list)


@dataclass
class Order:
    """The record of a commitment, once select/init/confirm complete."""
    id: str
    provider_id: str
    item_id: str
    status: Literal["QUOTED", "CONFIRMED", "REJECTED"] = "QUOTED"
    terms: dict = field(default_factory=dict)


@dataclass
class Message:
    """The envelope every node actually sends -- context + payload."""
    context: Context
    payload: dict = field(default_factory=dict)
