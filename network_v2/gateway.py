"""
Gateway service -- identical role to real_protocol/gateway.py: fans a
/search out to every BPP registered for the domain, then gets out of the
way. Copied into network_v2 on its own port, no dependency on the
existing system.

    uvicorn network_v2.gateway:app --port 9502
"""
import httpx
from fastapi import BackgroundTasks, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from network_v2.schemas import AckResponse, SearchRequest, ack

REGISTRY_URL = "http://127.0.0.1:9501"

app = FastAPI(title="Gateway (network_v2)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:9503", "http://127.0.0.1:9503"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


async def _broadcast(req: SearchRequest) -> None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{REGISTRY_URL}/lookup",
                                 params={"domain": req.context.domain, "type": "BPP"})
        subscribers = resp.json()
        print(f"[GATEWAY-v2] search on '{req.context.domain}' -> "
              f"broadcasting to {len(subscribers)} registered BPP(s)")
        for sub in subscribers:
            try:
                await client.post(f"{sub['url']}/search", json=req.model_dump())
            except httpx.HTTPError as exc:
                print(f"[GATEWAY-v2] could not reach {sub['subscriber_id']}: {exc}")


@app.post("/search", response_model=AckResponse)
async def search(req: SearchRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(_broadcast, req)
    return ack(req.context)
