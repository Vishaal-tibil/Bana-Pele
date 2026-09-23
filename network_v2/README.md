# network_v2 -- doc-aligned network + Naledi/Provider apps

A second, completely separate system from `real_protocol/` and
`frontend/` -- nothing here imports, modifies, or shares runtime state
with the existing prototype. It exists to close specific gaps between
`real_protocol/` and **Appendix B (Bana Pele ECD Network design)** of
`A13-Digital-Backbone-Functional-v22Sep2026.pdf`, and to give that closed
gap a real, driveable UI: a Naledi app and a Provider console, in the
spirit of the downloaded `BanaPele_UC1_UC2_Prototype` reference, but
wired to this real network rather than a single-process mock.

Only two files are shared with the rest of the repo, both read-only:
`domains/ngo_support.py` and `domains/coaching.py` (the same catalog
data `real_protocol/` uses). Nothing under `network_v2/` is imported by,
or imports from, `real_protocol/`.

## What's different from real_protocol

| | real_protocol | network_v2 |
|---|---|---|
| Ports | 9001-9003, 9101 onward | **9501-9503, 9601 onward** |
| Lifecycle | select -> init -> confirm (ends CONFIRMED) | select -> init -> confirm -> **fulfil -> verify** (QUOTED -> INITIATED -> RESERVED -> **FULFILLED -> VERIFIED**) -- closes Appendix B's Commitment lifecycle (B4) instead of stopping at confirm |
| select outcome | ACK now / NACK now (discovery-only only) | full-transaction providers can ACK-now-then-**decline-later** too, via a real accept/decline gate (see below) -- not just discovery-only NACKs |
| Consent | none | a real minimal `POST /client/consent` grant + ref, required on select (section 5) -- not a UI-only stub |
| Match transparency | filtered catalog only | each matched item also carries **why** it matched (`match_reason`) |
| Participant | anonymous BAP | a real `participant_name` carried through the Context |
| Frontend | React protocol-trace tool (`frontend/`) | two plain-HTML/JS apps: `webapp/naledi.html`, `webapp/provider.html` -- no build step, mounted directly on the BAP service |

### The accept/decline gate

This is the biggest structural change and the one most directly named in
the doc's UC2 narrative ("The Thabo reviews... accepts, declines...").
Real Beckn ACKs `select` immediately and answers later via `on_select` --
`real_protocol` always fires that `on_select` automatically in a
background task. `network_v2` uses that real gap honestly instead: a
full-transaction provider's `select` handler queues the request as
PENDING and does **not** call back until the Provider console explicitly
accepts or declines it (`POST /provider/pending/{tx_id}/accept|decline`
on that provider's own BPP process). Only then does `on_select` fire --
with a real quote if accepted, or a real decline reason if not. That's
what makes the Provider app a second party instead of a simulation.

## Running it

```
pip install -r network_v2/requirements.txt
python -m network_v2.serve
```

This boots 10 processes (Registry, Gateway, BAP, and one BPP per provider
in `domains/ngo_support.py` + `domains/coaching.py` -- currently 4 + 3)
on the port range above and stays up until Ctrl+C. It can run at the
same time as `real_protocol/`'s `python -m real_protocol.serve` -- no
shared ports, no shared state.

Then open **http://127.0.0.1:9503** -- that's the whole app: `/` links to
all three. `/naledi` is the seeker's app, `/provider` is the provider
console, and `/live` puts both side by side in one screen (each in its
own iframe) so one person can drive both without switching tabs. `/network`
is a fourth page -- the Network Console -- that talks directly to every
node's own port (not proxied through the BAP), so a viewer's own browser
requests are the proof the network is real: live health checks, each
provider's catalog read straight from its own `/catalog` endpoint, and
every transaction's full message trace. All four pages are served
directly from the BAP process, so there's exactly one thing to run and
one port to open.

Try it end to end with two browser tabs: open `/naledi`, search, request
a full-transaction provider; open `/provider` in the other tab, log in
as that provider, Accept it from the Inbox tab, then watch Naledi's tab
move on to "Confirm details" / "Finalize booking" on its own (it polls).
Once booked, switch back to the Provider tab's Active list and mark it
fulfilled -- Naledi's tab will offer to verify it, ending in a receipt
with a real order id.

Both apps have an expandable trace panel at the bottom of the screen
(the "Network trace" / "Recent actions" `<details>`) showing the real
request/response payloads as they happen -- nothing displayed is
invented client-side.

### Catalog taxonomy

`domains/ngo_support.py` and `domains/coaching.py` (shared with
`real_protocol/`) were rewritten so every provider name and item
category traces to a named source instead of being invented filler --
see each file's own docstring for exactly which line of the architecture
doc or which sibling artifact each name comes from. This is why the
provider count dropped from 6+5 to 4+3: the doc only names SmartStart,
Grow and the generic "Thabo" persona -- it doesn't name six specific
NGOs or five specific coaches, so this catalog no longer pretends it does.

## What's still out of scope

Same boundary as `real_protocol/`: no signing, no real identity/auth (the
`participant_name` field is a label, not authentication), no schema-file
validation, no live catalog publishing, no TTL enforcement, and nothing
from the full Journey Platform (Elevate, Connect Front Door, AI Knowledge
Services, Programme Dashboard) -- this is still the network-fabric layer
(Appendix B), now with more of that appendix actually implemented, not a
Journey Platform build.
