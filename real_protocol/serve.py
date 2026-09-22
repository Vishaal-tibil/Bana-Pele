"""
Boots every service real_protocol has for both domains -- Registry,
Gateway, BAP, the six ngo-support BPPs, and the five coaching BPPs -- and
registers them all, then just stays up so a frontend can drive them
interactively. run_demo.py boots only ngo-support, runs one scripted
transaction, and tears everything down at the end; this doesn't.

    python -m real_protocol.serve

Ctrl+C stops and tears down every process cleanly.
"""
import time

import httpx

from domains import coaching, ngo_support
from real_protocol.run_demo import (
    BAP_URL, GATEWAY_URL, REGISTRY_URL, start_service, wait_healthy,
)

NGO_PROVIDERS = ngo_support.build_providers()
NGO_PORTS = {p.id: 9101 + i for i, p in enumerate(NGO_PROVIDERS)}

COACHING_PROVIDERS = coaching.build_providers()
COACHING_PORTS = {p.id: 9107 + i for i, p in enumerate(COACHING_PROVIDERS)}

DOMAINS = [
    (ngo_support.DOMAIN, NGO_PROVIDERS, NGO_PORTS),
    (coaching.DOMAIN, COACHING_PROVIDERS, COACHING_PORTS),
]


def main():
    procs = []
    try:
        procs.append(start_service("real_protocol.registry", 9001))
        procs.append(start_service("real_protocol.gateway", 9002))
        procs.append(start_service("real_protocol.bap_service", 9003, {"BAP_PORT": "9003"}))
        for domain, providers, ports in DOMAINS:
            for p in providers:
                port = ports[p.id]
                procs.append(start_service("real_protocol.bpp_service", port, {
                    "BPP_ID": p.id, "BPP_PORT": str(port), "BPP_DOMAIN": domain,
                }))

        print("waiting for services to come up...")
        all_ports = [*NGO_PORTS.values(), *COACHING_PORTS.values()]
        for url in [REGISTRY_URL, GATEWAY_URL, BAP_URL] + [f"http://127.0.0.1:{port}" for port in all_ports]:
            wait_healthy(url)
        print("all services healthy\n")

        with httpx.Client(timeout=5.0) as client:
            # Registry's Subscriber model only holds one domain per subscriber_id, and
            # nothing actually looks up BAP subscribers (the gateway only looks up
            # BPPs) -- one registration is enough, it's here for directory completeness.
            client.post(f"{REGISTRY_URL}/subscribe", json={
                "subscriber_id": "nfh-bap", "url": BAP_URL, "domain": ngo_support.DOMAIN, "type": "BAP",
            })
            for domain, providers, ports in DOMAINS:
                for p in providers:
                    client.post(f"{REGISTRY_URL}/subscribe", json={
                        "subscriber_id": p.id, "url": f"http://127.0.0.1:{ports[p.id]}",
                        "domain": domain, "type": "BPP", "participation_type": p.participation_type,
                    })
        print(f"registered 1 BAP + {len(NGO_PROVIDERS)} ngo-support BPPs + "
              f"{len(COACHING_PROVIDERS)} coaching BPPs\n")
        print(f"BAP client API ready at {BAP_URL}  (this is what the frontend talks to)")
        print("Ctrl+C to stop all services.\n")

        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait(timeout=5)


if __name__ == "__main__":
    main()
