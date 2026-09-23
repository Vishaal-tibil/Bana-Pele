"""
Boots every network_v2 service -- Registry, Gateway, BAP (which also
serves the webapps), one BPP per **independent** provider in
domains/ngo_support.py and domains/coaching.py, and the My Journey
Network Adapter (one process, standing in for every **Platform-mediated**
provider -- see journey_adapter.py) -- on a port range that never
overlaps the existing real_protocol system, and keeps them up so the
webapps can drive them interactively.

Port map (compare to real_protocol's 9001-9003 / 9101 onward):
    9501       Registry
    9502       Gateway
    9503       BAP + webapps  <- open this one in a browser
    9601 on    independent ngo-support BPPs, one per provider
    9605       My Journey Network Adapter (mediates Imbe today)
    9607 on    independent coaching BPPs, one per provider

    python -m network_v2.serve

Ctrl+C stops and tears down every process cleanly.
"""
import subprocess
import sys
import time

import httpx

from domains import coaching, ngo_support

REGISTRY_URL = "http://127.0.0.1:9501"
GATEWAY_URL = "http://127.0.0.1:9502"
BAP_URL = "http://127.0.0.1:9503"
ADAPTER_PORT = 9605
ADAPTER_URL = f"http://127.0.0.1:{ADAPTER_PORT}"

NGO_PROVIDERS = ngo_support.build_providers()
NGO_PORTS = {p.id: 9601 + i for i, p in enumerate(NGO_PROVIDERS)}
NGO_MEDIATED = ngo_support.build_mediated_providers()

COACHING_PROVIDERS = coaching.build_providers()
COACHING_PORTS = {p.id: 9607 + i for i, p in enumerate(COACHING_PROVIDERS)}

DOMAINS = [
    (ngo_support.DOMAIN, NGO_PROVIDERS, NGO_PORTS),
    (coaching.DOMAIN, COACHING_PROVIDERS, COACHING_PORTS),
]


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
        procs.append(start_service("network_v2.registry", 9501))
        procs.append(start_service("network_v2.gateway", 9502))
        procs.append(start_service("network_v2.bap_service", 9503, {"BAP_PORT": "9503"}))
        for domain, providers, ports in DOMAINS:
            for p in providers:
                port = ports[p.id]
                procs.append(start_service("network_v2.bpp_service", port, {
                    "BPP_ID": p.id, "BPP_PORT": str(port), "BPP_DOMAIN": domain,
                }))
        if NGO_MEDIATED:
            procs.append(start_service("network_v2.journey_adapter", ADAPTER_PORT,
                                        {"ADAPTER_PORT": str(ADAPTER_PORT)}))

        print("waiting for network_v2 services to come up...")
        all_ports = [*NGO_PORTS.values(), *COACHING_PORTS.values()]
        wait_urls = [REGISTRY_URL, GATEWAY_URL, BAP_URL] + [f"http://127.0.0.1:{port}" for port in all_ports]
        if NGO_MEDIATED:
            wait_urls.append(ADAPTER_URL)
        for url in wait_urls:
            wait_healthy(url)
        print("all network_v2 services healthy\n")

        with httpx.Client(timeout=5.0) as client:
            client.post(f"{REGISTRY_URL}/subscribe", json={
                "subscriber_id": "nfh-bap-v2", "url": BAP_URL, "domain": ngo_support.DOMAIN, "type": "BAP",
            })
            for domain, providers, ports in DOMAINS:
                for p in providers:
                    client.post(f"{REGISTRY_URL}/subscribe", json={
                        "subscriber_id": p.id, "url": f"http://127.0.0.1:{ports[p.id]}",
                        "domain": domain, "type": "BPP", "participation_type": p.participation_type,
                        "participation_pattern": "independent",
                    })
            for p in NGO_MEDIATED:
                client.post(f"{REGISTRY_URL}/subscribe", json={
                    "subscriber_id": p.id, "url": ADAPTER_URL,
                    "domain": ngo_support.DOMAIN, "type": "BPP", "participation_type": p.participation_type,
                    "participation_pattern": "platform_mediated",
                })
        print(f"registered 1 BAP + {len(NGO_PROVIDERS)} independent ngo-support BPPs + "
              f"{len(NGO_MEDIATED)} Platform-mediated (via My Journey Adapter) + "
              f"{len(COACHING_PROVIDERS)} independent coaching BPPs\n")
        print(f"Open http://127.0.0.1:9503 in a browser -- Naledi's app, the Provider console "
              f"and the Network Console are all served from there.")
        print("(This is a separate port range from the existing real_protocol system -- "
              "both can run at the same time.)")
        print("Ctrl+C to stop all network_v2 services.\n")

        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nstopping network_v2...")
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait(timeout=5)


if __name__ == "__main__":
    main()
