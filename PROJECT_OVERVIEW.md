# Bana Pele Digital Backbone -- Prototype Overview

*A plain-language walkthrough of everything in this repo, why it exists, and how it
fits together. If you only read one document to get oriented, read this one --
each folder also has its own README with more technical depth once you know
where to look.*

## The one-paragraph version

This repo proves a specific idea from the Bana Pele architecture design: that
independent organisations (NGOs, coaches) can publish what they offer and
transact with people who need it, over a shared network, without any of them
needing to be the same company or run the same software. It does this by
actually building that network -- twice, at increasing levels of realism --
rather than just describing it. What started as a same-process simulation is
now several genuinely separate, independently-running services that talk to
each other over real HTTP, matching the discover -> select -> init -> confirm
-> fulfil -> verify lifecycle the architecture document describes.

## Why this exists

`A13-Digital-Backbone-Functional-v22Sep2026.pdf` is the architecture document
this whole repo is built against. Two things from it matter most for
understanding what's here:

- **Two use cases**: UC1, "Connected NGO Support Network" (an early-childhood
  practitioner discovering NGO support), and UC2, "Naledi Discovers the Right
  Thabo" (finding a coach). Both are demonstrated end to end in this repo.
- **Appendix B**, the Bana Pele ECD Network design -- Registry, Gateway, BAP
  and BPP nodes, a discovery-then-transaction lifecycle, and two distinct
  participation pathways (an organisation can run its own node, or be
  published and answered for by a shared adapter). This repo is scoped to
  proving *this* layer works, for real -- it is not an attempt to build the
  rest of the architecture (Journey Platform, consent policy engine, AI
  knowledge services, dashboards) described elsewhere in the doc.

## How it evolved -- four stages, each still in the repo

### Stage 1 -- the original simulation (`shared/`, `domains/`, `run_uc1.py`, `run_uc2.py`)

The starting point. `shared/network.py` defines `Registry`, `Gateway`, `BAP`
and `BPP` as plain Python classes that call each other's methods directly,
all inside one process. `domains/ngo_support.py` and `domains/coaching.py`
hold the catalog data both use cases share. This proved the message shapes
and the discovery-only-vs-full-transaction distinction, but nothing here is a
real network -- it's one program simulating four roles.

Run it: `python3 run_uc1.py` or `python3 run_uc2.py`.

### Stage 2 -- `api.py` + `frontend/`: the first real HTTP wrapper

`api.py` puts a FastAPI layer directly on top of the Stage 1 classes, so a
browser can drive a real session over HTTP instead of reading a script's
console output. `frontend/` (Vite + React + TypeScript) is the UI for it --
a network diagram, a real search box, and a JSON/trace inspector. This proved
the same simulation could be driven live, but underneath it's still the same
single-process classes from Stage 1; `api.py` is an orchestration layer, not
a new protocol implementation.

### Stage 3 -- `real_protocol/`: genuinely separate services

This is where the network became real. Instead of one process pretending to
be four roles, `real_protocol/` runs Registry, Gateway, BAP, and one process
*per provider* as separate OS processes on separate ports, talking only over
HTTP. It also implements the async pattern properly: a request like `search`
or `select` gets an immediate ACK/NACK, and the real content (a catalog, a
quote) arrives later as a *separate* callback the provider posts back to the
BAP -- not a direct function return. `frontend/` was pointed at this instead
of `api.py`, and grew a real search box: what you type becomes the actual
search sent over HTTP, and only providers whose catalog genuinely matches
respond.

Run it: `python -m real_protocol.serve`, then `cd frontend && npm run dev`.

### Stage 4 -- `network_v2/`: closing the remaining gaps

A second, completely separate system (own ports, no shared runtime state with
`real_protocol/`) built to close two things Stage 3 didn't yet have, and to
give the result a driveable interface without needing developer tools:

1. **The full commitment lifecycle.** Appendix B's lifecycle goes
   Publish -> Discover -> Select -> Commit -> Fulfil -> Acknowledge -- Stage 3
   stopped at "confirm". `network_v2` adds real `fulfil` (provider marks the
   support actually delivered) and `verify` (the participant confirms it
   happened) steps, plus a real accept/decline gate on `select` (a
   full-transaction provider can now generically decline a request, not just
   synchronously refuse as a discovery-only one) and a minimal real consent
   grant.
2. **The other participation pathway.** The architecture doc describes two
   ways an organisation can be on the network: as an *independent node*
   (SmartStart, Grow -- each running its own process), or *Platform-mediated*
   (the doc names Imbe for this specifically: "SmartStart and Grow are
   examples; IMBE may instead participate through the Platform"). Nothing
   before this stage implemented the second pathway at all. `network_v2`
   adds the **My Journey Network Adapter** -- one real process that publishes
   and answers on Imbe's behalf, indistinguishable from an ordinary provider
   to the rest of the network; the only difference is *who's running the
   server behind the URL*.

It also ships five browser pages, all served from one process so there's
exactly one thing to run:

| Page | What it's for |
|---|---|
| `/` | Landing page, links to everything below |
| `/naledi` | The seeker's app -- log in, search, request, wait for a real response, confirm |
| `/provider` | The provider's console -- log in as any registered NGO or coach, accept/decline/fulfil |
| `/live` | Both of the above side by side in one screen (two iframes), so one person can drive a full transaction without switching tabs |
| `/network` | The Network Console -- proof, not narration: every call on this page goes straight to that node's own port, so a viewer's own browser requests are the evidence the network is real, not something asserted |

Run it: `python -m network_v2.serve`, then open `http://127.0.0.1:9503`.

### A pass that touched all four stages: the catalog itself

Partway through Stage 4, the catalog data was audited against the
architecture document and found to contain names and item descriptions that
were never actually sourced from it -- invented for demo richness, then
carried forward from Stage 1 onward. `domains/ngo_support.py` and
`domains/coaching.py` were rewritten so **every provider name and item
category traces to something named** in the architecture document or a
sibling project artifact, documented in each file's own docstring. This is
why the roster is smaller now (3 NGO providers + 3 coaches, down from 6 + 5)
-- the document simply doesn't name six specific NGOs or five specific
coaches, so the catalog no longer pretends it does. Because `real_protocol/`
and `network_v2/` both read this same file, the change (and a couple of
small compensating fixes where `real_protocol/`'s own demo script referenced
providers that no longer exist) reached both systems.

## The concepts, plainly

| Term | What it means here |
|---|---|
| **Registry** | The directory of who's registered for which domain, at which URL. Never transacts. |
| **Gateway** | Looks up the Registry and forwards a search to everyone registered for that domain. Only involved in discovery -- every later step (select/init/confirm/fulfil) goes straight from the BAP to the provider's own URL, bypassing the Gateway entirely. |
| **BAP** (Beckn Application Platform) | Acts on the seeker's behalf. The one node a client app actually talks to. |
| **BPP** (Beckn Provider Platform) | One process per provider, holding only that provider's own catalog. Where discovery-only vs. full-transaction is enforced. |
| **Discovery-only vs. full-transaction** | Whether a provider can only be *found* (and must be contacted directly to actually get support) or can complete a full booking through the network. A discovery-only provider NACKs any attempt to `select` it, with a real error message, not a fabricated one. |
| **Independent node vs. Platform-mediated** | Whether a provider runs its own BPP process, or is published and answered for by a shared adapter (the My Journey Network Adapter) because it doesn't want or need the integration burden of running its own server. |
| **"In the network"** | Concretely: having a row in the Registry. Nothing more. A provider that's never been registered doesn't get asked, can't be reached, and isn't discoverable -- it isn't hidden or disabled, it simply doesn't exist from the network's point of view. |

## What's in the catalog right now

**UC1 -- NGO Support** (`domains/ngo_support.py`): SmartStart and Grow
(independent, full-transaction), Imbe (Platform-mediated, discovery-only).

**UC2 -- Coaching** (`domains/coaching.py`): Thabo A and Thabo B (independent,
full-transaction), Thabo C (independent, discovery-only).

Every item name and description is quoted from the architecture document's
own Section 8 "Value exchange domains" table, not invented -- see the
docstring at the top of each `domains/` file for exactly which line
justifies which entry.

## What this proves, and what it deliberately doesn't

**Proven, and checkable yourself:** real separate processes (kill one, the
others keep running); real async ACK-then-callback messaging; real search
matching (a provider with nothing relevant stays silent, it doesn't fake a
match); a real discovery-only rejection with the exact error the code
produces; a real accept/decline gate a provider's own console controls; the
full lifecycle through to a real, unique order id on every run.

**Deliberately out of scope:** real authentication (names are labels, not
logins -- the login screens say this plainly); a real consent *policy*
engine (the grant is real and stored, but nothing currently restricts what
data flows based on it); schema-file validation or message signing; and
everything upstream of the network layer itself -- the Journey Platform,
Elevate integration, AI Knowledge Services, and the Programme Dashboard the
architecture document describes are not built here. This repo is the
network-fabric layer (Appendix B), built to be as real as that layer can be
made, not a Journey Platform implementation.

## Running everything

```
pip install -r requirements.txt          # shared + api.py + real_protocol
pip install -r network_v2/requirements.txt

python -m real_protocol.serve            # ports 9001-9003, 9101 onward
python -m network_v2.serve               # ports 9501-9503, 9601 onward -- open http://127.0.0.1:9503

cd frontend && npm install && npm run dev  # port 5173, wired to real_protocol
```

Both backend systems can run at the same time -- they share no ports and no
runtime state, only the read-only catalog data in `domains/`.

## Where to go for more detail

- [`README.md`](README.md) -- quick start, the original simulation, the
  two-person editing convention for `domains/`.
- [`real_protocol/README.md`](real_protocol/README.md) -- what's real about
  that system specifically, versus `shared/` and `api.py`.
- [`network_v2/README.md`](network_v2/README.md) -- what's different from
  `real_protocol/`, the accept/decline gate, the commitment lifecycle, and
  the Platform-mediated pathway in full detail.
- `domains/ngo_support.py` and `domains/coaching.py` -- the catalog itself,
  with the sourcing for every name in the module docstring.
