"""
Shared network infrastructure -- Registry, Gateway, BAP, BPP.
Domain-agnostic: any use case plugs in its own catalog data via BPP's
constructor and gets the same protocol behaviour for free.

Simplification vs. real Beckn: this runs synchronous request/response
in-process (async functions calling each other directly) rather than
separate HTTP services exchanging async on_* callbacks. The message
shapes and node responsibilities are faithful to the real protocol --
converting this to real FastAPI services later is a matter of wrapping
each method in an HTTP endpoint, not rewriting the logic.
"""
import uuid
from typing import Optional
from .models import Context, Intent, Provider, Order, Message


class Registry:
    """Facilitator-side. Knows who's on the network and what domain they serve.
    Never transacts itself -- exactly the DeDi Registry's role."""

    def __init__(self):
        self._nodes: dict[str, Provider] = {}

    def register(self, provider: Provider, domain: str):
        self._nodes[provider.id] = (provider, domain)
        print(f"[REGISTRY] registered {provider.id} ({provider.participation_type}) "
              f"for domain '{domain}'")

    def lookup(self, domain: str) -> list[Provider]:
        return [p for p, d in self._nodes.values() if d == domain]


class Gateway:
    """Facilitator-side. Broadcasts discover to every matching BPP,
    aggregates responses. Never transacts itself -- exactly the
    Gateway's role in the real network."""

    def __init__(self, registry: Registry):
        self.registry = registry
        self._bpp_handlers: dict[str, "BPP"] = {}

    def attach(self, bpp: "BPP"):
        self._bpp_handlers[bpp.provider.id] = bpp

    async def broadcast_discover(self, discover_msg: Message) -> list[Message]:
        domain = discover_msg.context.domain
        candidates = self.registry.lookup(domain)
        print(f"[GATEWAY] discover on '{domain}' -> broadcasting to "
              f"{len(candidates)} registered node(s)")
        responses = []
        for provider in candidates:
            bpp = self._bpp_handlers[provider.id]
            responses.append(await bpp.on_discover(discover_msg))
        return responses

    async def route(self, msg: Message) -> Message:
        """Route select/init/confirm to the specific BPP it targets."""
        bpp = self._bpp_handlers[msg.context.bpp_id]
        handler = {"select": bpp.on_select, "init": bpp.on_init,
                   "confirm": bpp.on_confirm}[msg.context.action]
        return await handler(msg)


class BAP:
    """Asks the network on someone's behalf. Never answers -- pure BAP-side,
    matching Service 5 in our architecture (asks only)."""

    def __init__(self, bap_id: str, gateway: Gateway):
        self.bap_id = bap_id
        self.gateway = gateway

    async def discover(self, domain: str, intent: Intent) -> list[Message]:
        tx_id = str(uuid.uuid4())[:8]
        ctx = Context(action="discover", domain=domain, transaction_id=tx_id, bap_id=self.bap_id)
        msg = Message(context=ctx, payload={"intent": intent})
        print(f"\n[BAP:{self.bap_id}] discover({domain}) -- intent={intent.category}")
        return await self.gateway.broadcast_discover(msg)

    async def select(self, on_discover_msg: Message, item_id: str) -> Message:
        ctx = on_discover_msg.context.reply("select", on_discover_msg.context.bpp_id)
        ctx.bap_id = self.bap_id
        msg = Message(context=ctx, payload={"item_id": item_id})
        print(f"[BAP:{self.bap_id}] select({item_id}) -> {ctx.bpp_id}")
        return await self.gateway.route(msg)

    async def init(self, select_reply: Message) -> Message:
        ctx = select_reply.context.reply("init", select_reply.context.bpp_id)
        ctx.bap_id = self.bap_id
        msg = Message(context=ctx, payload=select_reply.payload)
        print(f"[BAP:{self.bap_id}] init() -> {ctx.bpp_id}")
        return await self.gateway.route(msg)

    async def confirm(self, init_reply: Message) -> Message:
        ctx = init_reply.context.reply("confirm", init_reply.context.bpp_id)
        ctx.bap_id = self.bap_id
        msg = Message(context=ctx, payload=init_reply.payload)
        print(f"[BAP:{self.bap_id}] confirm() -> {ctx.bpp_id}")
        return await self.gateway.route(msg)


class BPP:
    """Answers the network. participation_type decides how much of the
    lifecycle it supports -- this is where discovery_only vs.
    full_transaction actually gets enforced."""

    def __init__(self, provider: Provider):
        self.provider = provider

    async def on_discover(self, discover_msg: Message) -> Message:
        ctx = discover_msg.context.reply("on_discover", self.provider.id)
        catalog = {"provider": self.provider.name,
                   "participation_type": self.provider.participation_type,
                   "items": [i.__dict__ for i in self.provider.items]}
        print(f"  [BPP:{self.provider.id}] on_discover -> "
              f"{len(self.provider.items)} item(s), type={self.provider.participation_type}")
        return Message(context=ctx, payload={"catalog": catalog})

    def _reject_if_discovery_only(self, ctx: Context) -> Optional[Message]:
        if self.provider.participation_type == "discovery_only":
            print(f"  [BPP:{self.provider.id}] REJECTED -- discovery-only node, "
                  f"cannot process '{ctx.action}'. Fulfilment happens outside the network.")
            reply_ctx = ctx.reply(f"on_{ctx.action}", self.provider.id)
            return Message(context=reply_ctx, payload={
                "error": "NOT_SUPPORTED",
                "reason": "This provider is discovery-only. Contact them directly to proceed.",
            })
        return None

    async def on_select(self, msg: Message) -> Message:
        rejected = self._reject_if_discovery_only(msg.context)
        if rejected:
            return rejected
        item_id = msg.payload["item_id"]
        item = next(i for i in self.provider.items if i.id == item_id)
        print(f"  [BPP:{self.provider.id}] on_select -> quoting {item.name}")
        ctx = msg.context.reply("on_select", self.provider.id)
        return Message(context=ctx, payload={"item_id": item_id, "quote": item.attributes})

    async def on_init(self, msg: Message) -> Message:
        rejected = self._reject_if_discovery_only(msg.context)
        if rejected:
            return rejected
        print(f"  [BPP:{self.provider.id}] on_init -> terms confirmed")
        ctx = msg.context.reply("on_init", self.provider.id)
        return Message(context=ctx, payload={**msg.payload, "terms": "standard"})

    async def on_confirm(self, msg: Message) -> Message:
        rejected = self._reject_if_discovery_only(msg.context)
        if rejected:
            return rejected
        order = Order(id=str(uuid.uuid4())[:8], provider_id=self.provider.id,
                       item_id=msg.payload["item_id"], status="CONFIRMED")
        print(f"  [BPP:{self.provider.id}] on_confirm -> order {order.id} CONFIRMED")
        ctx = msg.context.reply("on_confirm", self.provider.id)
        return Message(context=ctx, payload={"order_id": order.id, "status": order.status})
