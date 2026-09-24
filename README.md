# Bana Pele Network Prototype

A working, runnable prototype of the Bana Pele ECD Network described in
`A13-Digital-Backbone-Functional-v22Sep2026.pdf` (Appendix B): independent
organisations (NGOs, coaches) publish what they offer, people discover and
request it over a shared network, and a request runs through a real
lifecycle -- **search -> select -> init -> confirm -> fulfil -> verify**.

New to the repo? Read [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) first
(plain-language story of what was built and why), then come back here for
the commands.

## What's in this repo

There are four layers, each a step up in realism from the one before. All
four are still here and still runnable.

| Folder / file | What it is | Runs on |
|---|---|---|
| `shared/`, `run_uc1.py`, `run_uc2.py`, `run_demo.py` | The original simulation: Registry, Gateway, BAP, BPP as plain Python classes inside one process | terminal only |
| `api.py` + `frontend/` | A FastAPI wrapper around that simulation, plus a React UI | `:8000` |
| `real_protocol/` + `frontend/` | Every node is its own real HTTP process; async ACK-then-callback messaging; the React UI points here | `:9001-9003`, `:9101+`, UI on `:5173` |
| **`network_v2/`** | **The latest system.** Everything in `real_protocol/`, plus the full commitment lifecycle, an accept/decline gate, consent, the My Journey Network Adapter (Platform-mediated participants), and five browser pages served from one port | `:9501-9503`, `:9601+`, UI on `:9503` |
| `domains/` | The catalog (providers and what they offer) -- the one data source all of the above read | -- |

**If you just want to see the latest thing working, go to
[Quick start: network_v2](#quick-start-network_v2-the-latest-system).**

## Prerequisites

- **Python 3.10 or newer** (developed and tested on 3.13)
- **Node.js 18 or newer** -- only needed for the React app in `frontend/`
- Nothing else. No database, no Docker, no API keys, no internet needed at run time.

Install the Python dependencies once, from the repo root:

```bash
pip install -r requirements.txt
```

> On Windows use `python` and `pip`; on macOS/Linux use `python3` and `pip3`.
> Every command below is run **from the repo root** (the folder containing
> this README) -- the services import `domains` and `network_v2` as packages,
> so running from another directory will fail with `ModuleNotFoundError`.

## Quick start: network_v2 (the latest system)

```bash
python -m network_v2.serve
```

This starts 9 separate processes and keeps them running until you press
**Ctrl+C**:

| Port | Process |
|---|---|
| 9501 | Registry |
| 9502 | Gateway |
| 9503 | BAP -- also serves all the web pages |
| 9601, 9602 | SmartStart, Grow (independent providers, UC1) |
| 9605 | My Journey Network Adapter (answers for Imbe, a Platform-mediated provider, UC1) |
| 9607, 9608, 9609 | Thabo A, Thabo B, Thabo C (independent providers, UC2) |

Then open **http://127.0.0.1:9503** in a browser:

| URL | What you get |
|---|---|
| `/` | Landing page linking to everything |
| `/live` | **Best place to start.** Naledi's app and the Provider console side by side -- request on the left, accept/decline/fulfil on the right, in real time |
| `/naledi` | The seeker's app on its own (log in, search, request, confirm) |
| `/provider` | The provider's console on its own (log in as any registered provider) |
| `/network` | The Network Console -- live health of every node, every provider's catalog read straight from its own port, a topology diagram, and the full message trace of every transaction |

### Walk through one full transaction (about a minute)

1. Open `http://127.0.0.1:9503/live`.
2. **Left pane (Naledi):** log in with any name -> pick *NGO support* -> leave the search
   box blank -> **Search the network**. Three providers answer.
3. Click **Request this** on **SmartStart** -> **Agree & send request**. Naledi now
   waits -- the request is genuinely pending on SmartStart's side.
4. **Right pane (Provider):** choose *NGO support* -> *smartstart* -> **Log in** -> the
   request is in the Inbox -> **Accept**.
5. Left pane moves on by itself: **Confirm details** -> **Finalize booking** (order is now
   reserved).
6. Right pane: **Active** tab -> **Mark fulfilled**.
7. Left pane: **Yes, confirm it happened** -> a receipt with a real order id.
8. Open `http://127.0.0.1:9503/network` and click the transaction row to see every
   message that crossed the network.

Two things worth trying: request **Imbe** (a discovery-only provider) and watch it
get refused with the real error message; and search for `learning` or `Sesotho` to see
that only providers whose catalog genuinely matches will answer.

## Quick start: real_protocol + React app

```bash
# terminal 1 -- from the repo root
python -m real_protocol.serve          # ports 9001-9003, 9101 onward

# terminal 2
cd frontend
npm install                            # first time only
npm run dev                            # http://localhost:5173
```

Open **http://localhost:5173**, pick UC1 or UC2, type a search, pick a result.
`real_protocol` has no accept/decline gate, no My Journey Adapter and stops
at `confirm` -- those are what `network_v2` adds (see its README).

## Quick start: the original simulation

```bash
python run_uc1.py      # UC1 -- NGO support, printed to the terminal
python run_uc2.py      # UC2 -- coaching
python run_demo.py     # both, back to back
python api.py          # the same simulation behind HTTP, on :8000
```

## Running several systems at once

`real_protocol` (9001-9111 range), `network_v2` (9501-9611 range), `api.py`
(8000) and the React dev server (5173) use different ports and share no
state, so they can all run at the same time. The only thing they share is
the read-only catalog in `domains/`.

## Troubleshooting

**`[Errno 10048]` / "address already in use" when starting a system.**
An earlier copy is still running and holding the ports. Note that the
launcher can still print "all services healthy" in this case -- it is
health-checking the *old* copy. Stop the old one first.

```powershell
# Windows PowerShell -- find what's holding a port, then stop it
netstat -ano | findstr :9503
taskkill /F /PID <the-pid-from-the-last-column>
```

```bash
# macOS / Linux
lsof -i :9503
kill <pid>
```

The clean way to avoid this is to always stop a system with **Ctrl+C** in
the terminal where you started it -- that tears down every process it
launched.

**`ModuleNotFoundError: No module named 'domains'` (or `network_v2`).**
You ran the command from inside a sub-folder. `cd` to the repo root.

**A web page shows "Failed to fetch".** The backend isn't running (or you
started it from the wrong directory). Start `python -m network_v2.serve`
and reload.

**Changed a `.py` file but nothing changed.** The services don't auto-reload.
Ctrl+C the launcher and start it again. (Edits to the `.html` files in
`network_v2/webapp/` do show up on a plain browser refresh.)

## The catalog

Every provider and item lives in two files, and every name in them is traced
to a source (the architecture document, or a named sibling artifact) in the
file's own docstring -- nothing is invented filler:

- `domains/ngo_support.py` -- UC1: SmartStart, Grow (independent nodes) and
  Imbe (Platform-mediated, via the My Journey Adapter)
- `domains/coaching.py` -- UC2: Thabo A, Thabo B, Thabo C

To change what's on the network, edit those files and restart. Each provider
becomes its own process automatically; nothing else needs touching.

## Where to read next

| If you want... | Read |
|---|---|
| The story of how this was built and why | [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) |
| A file-by-file explanation of the latest code, every endpoint, and how a request flows | [`network_v2/README.md`](network_v2/README.md) |
| What's real (and what's still simplified) in `real_protocol` | [`real_protocol/README.md`](real_protocol/README.md) |

## What is deliberately not built

No real authentication (names are labels; the login screens say so), no
message signing or schema-file validation, and nothing from the wider
architecture beyond the network layer -- the Journey Platform, Elevate
integration, AI knowledge services and programme dashboard are out of scope.
The consent grant is real and stored, but nothing yet restricts what data
flows based on it.
