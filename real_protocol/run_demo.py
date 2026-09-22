"""
Boots Registry, Gateway, BAP and six BPPs as six separate OS processes on
six separate ports, registers them, then drives one full search ->
select -> init -> confirm lifecycle against a real (full_transaction)
provider and shows a discovery_only provider NACKing select -- over real
HTTP, exactly the flow shared/network.py's run_uc1.py drives in-process.

    python -m real_protocol.run_demo
"""
import subprocess
import sys
import time

import httpx

from domains.ngo_support import build_providers

REGISTRY_URL = "http://127.0.0.1:9001"
GATEWAY_URL = "http://127.0.0.1:9002"
BAP_URL = "http://127.0.0.1:9003"

PROVIDERS = build_providers()
BPP_PORTS = {p.id: 9101 + i for i, p in enumerate(PROVIDERS)}


def start_service(module: str, port: int, extra_env: dict | None = None) -> subprocess.Popen:
    import os
    env = {**os.environ, **(extra_env or {})}
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", f"{module}:app", "--port", str(port), "--log-level", "warning"],
        env=env,
    )


def wait_healthy(url: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(f"{url}/health", timeout=1.0).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"service at {url} never became healthy")


def main():
    procs = []
    try:
        procs.append(start_service("real_protocol.registry", 9001))
        procs.append(start_service("real_protocol.gateway", 9002))
        procs.append(start_service("real_protocol.bap_service", 9003, {"BAP_PORT": "9003"}))
        for p in PROVIDERS:
            port = BPP_PORTS[p.id]
            procs.append(start_service("real_protocol.bpp_service", port,
                                        {"BPP_ID": p.id, "BPP_PORT": str(port)}))

        print("waiting for services to come up...")
        for url in [REGISTRY_URL, GATEWAY_URL, BAP_URL] + \
                   [f"http://127.0.0.1:{port}" for port in BPP_PORTS.values()]:
            wait_healthy(url)
        print("all services healthy\n")

        with httpx.Client(timeout=5.0) as client:
            client.post(f"{REGISTRY_URL}/subscribe", json={
                "subscriber_id": "nfh-bap", "url": BAP_URL, "domain": "ngo-support", "type": "BAP",
            })
            for p in PROVIDERS:
                client.post(f"{REGISTRY_URL}/subscribe", json={
                    "subscriber_id": p.id, "url": f"http://127.0.0.1:{BPP_PORTS[p.id]}",
                    "domain": "ngo-support", "type": "BPP", "participation_type": p.participation_type,
                })
            print(f"registered 1 BAP + {len(PROVIDERS)} BPPs\n")

            print("=== search ===")
            r = client.post(f"{BAP_URL}/client/search",
                             params={"domain": "ngo-support", "category": "starter_kit",
                                     "region": "Bushbuckridge"})
            tx_id = r.json()["transaction_id"]
            print(f"tx_id={tx_id}\n")

            results = []
            deadline = time.time() + 5.0
            while time.time() < deadline and len(results) < len(PROVIDERS):
                time.sleep(0.2)
                results = client.get(f"{BAP_URL}/client/results/{tx_id}").json()
            print(f"received on_search from {len(results)}/{len(PROVIDERS)} providers:")
            for r_ in results:
                prov = r_["provider"]
                print(f"  - {prov['id']} ({prov['participation_type']}): "
                      f"{len(prov['items'])} item(s)")
            print()

            print("=== full_transaction happy path: smartstart ===")
            client.post(f"{BAP_URL}/client/select",
                        params={"tx_id": tx_id, "bpp_id": "smartstart", "item_id": "starter_kit"})
            time.sleep(0.5)
            client.post(f"{BAP_URL}/client/init", params={"tx_id": tx_id, "bpp_id": "smartstart"})
            time.sleep(0.5)
            client.post(f"{BAP_URL}/client/confirm", params={"tx_id": tx_id, "bpp_id": "smartstart"})
            time.sleep(0.5)
            print()

            print("=== discovery_only rejection: impande ===")
            r = client.post(f"{BAP_URL}/client/select",
                             params={"tx_id": tx_id, "bpp_id": "impande", "item_id": "facility_grant"})
            print(f"select(impande) -> {r.json()}\n")

            print("=== full message trail for this transaction ===")
            log = client.get(f"{BAP_URL}/client/log/{tx_id}").json()
            for entry in log:
                print(f"  [{entry['direction']:>8}] {entry['note']}")

    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait(timeout=5)


if __name__ == "__main__":
    main()
