"""Shared scenario runner -- do not edit unless changing behaviour for BOTH use cases."""
import json
from shared.network import Registry, Gateway, BAP, BPP

def rule(title=""):
    print("\n" + "=" * 70)
    if title:
        print(title); print("=" * 70)

async def run_scenario(domain, providers, intent, bap_id):
    rule(f"SCENARIO: domain='{domain}'  bap='{bap_id}'")
    registry = Registry(); gateway = Gateway(registry)
    for p in providers:
        registry.register(p, domain); gateway.attach(BPP(p))
    bap = BAP(bap_id, gateway)

    on_discover_msgs = await bap.discover(domain, intent)
    print(f"\n[BAP:{bap_id}] received {len(on_discover_msgs)} on_discover response(s):")
    full_tx_options = []
    for m in on_discover_msgs:
        cat = m.payload["catalog"]
        print(f"   - {cat['provider']} ({cat['participation_type']}): {[i['name'] for i in cat['items']]}")
        if cat["participation_type"] == "full_transaction":
            full_tx_options.append(m)

    discovery_only_msg = next(m for m in on_discover_msgs if m.payload["catalog"]["participation_type"] == "discovery_only")
    rule("Attempting full transaction with a DISCOVERY-ONLY node (expected: rejected)")
    item_id = discovery_only_msg.payload["catalog"]["items"][0]["id"]
    reject = await bap.select(discovery_only_msg, item_id)
    print(f"\n[BAP:{bap_id}] response: {json.dumps(reject.payload, indent=2)}")

    rule("Completing a full transaction with a FULL-TRANSACTION node")
    chosen = full_tx_options[0]
    item_id = chosen.payload["catalog"]["items"][0]["id"]
    select_reply = await bap.select(chosen, item_id)
    init_reply = await bap.init(select_reply)
    confirm_reply = await bap.confirm(init_reply)
    print(f"\n[BAP:{bap_id}] FINAL RESULT: {json.dumps(confirm_reply.payload, indent=2)}")
    return confirm_reply
