"""
Gateway service -- fans a /search out to every BPP registered for the
domain over real HTTP, then gets out of the way. Exactly like real Beckn:
the gateway is only in the loop for discovery. select/init/confirm go
directly BAP <-> BPP once the BAP knows a bpp_uri from on_search. Run
standalone:

    uvicorn real_protocol.gateway:app --port 9002
"""
import httpx
from fastapi import BackgroundTasks, FastAPI

from real_protocol.schemas import AckResponse, SearchRequest, ack

REGISTRY_URL = "http://127.0.0.1:9001"

app = FastAPI(title="Gateway")


@app.get("/health")
def health():
    return {"status": "ok"}


async def _broadcast(req: SearchRequest) -> None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{REGISTRY_URL}/lookup",
                                 params={"domain": req.context.domain, "type": "BPP"})
        subscribers = resp.json()
        print(f"[GATEWAY] search on '{req.context.domain}' -> "
              f"broadcasting to {len(subscribers)} registered BPP(s)")
        for sub in subscribers:
            try:
                await client.post(f"{sub['url']}/search", json=req.model_dump())
            except httpx.HTTPError as exc:
                print(f"[GATEWAY] could not reach {sub['subscriber_id']}: {exc}")


@app.post("/search", response_model=AckResponse)
async def search(req: SearchRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(_broadcast, req)
    return ack(req.context)
