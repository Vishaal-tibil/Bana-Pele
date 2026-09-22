# Beckn Network Prototype -- Shared Infrastructure

Working code demonstrating the Beckn-style network: Registry, Gateway, BAP
and BPP nodes, with **discovery-only** and **full-transaction** participation
types enforced end to end -- exactly as scoped in the NFH network design notes.

## Run it

No dependencies. Python 3.9+ only.

```
cd beckn_demo
python3 run_demo.py
```

Runs UC1 (NGO support) and UC2 (coaching) back to back, using the *same*
`shared/network.py` -- proving both use cases sit on identical, consistent
infrastructure, per the meeting notes' explicit ask.

## Structure

```
shared/
  models.py    -- message contracts (Context, Intent, Provider, Order)
  network.py   -- Registry, Gateway, BAP, BPP -- the actual protocol logic
domains/
  ngo_support.py  -- UC1 data (Vishaal plugs in real NGO catalog here)
  coaching.py     -- UC2 data (Inchara plugs in real coach catalog here)
run_demo.py    -- wires it together, walks through both scenarios
```

## To build your own use case on this

Only touch `domains/`. Copy `ngo_support.py`, rename it, replace the
`Provider`/`Item` list with your own catalog, and pass it into
`run_scenario()` in `run_demo.py`. `shared/network.py` never needs to change.

## What's simplified vs. real Beckn/ONIX -- know this before presenting

- **Synchronous, in-process** -- BAP calls Gateway which calls each BPP
  directly and waits for a reply. Real Beckn is asynchronous: a BAP sends
  `discover` and gets an immediate ACK, then `on_discover` arrives later as
  a *separate* callback. This demo collapses that into a normal function
  call for simplicity and reliability when presenting live.
- **No real HTTP, no real network** -- everything runs in one Python
  process. Converting to real services (FastAPI apps on different ports,
  as ONIX actually does it) means wrapping each method in an HTTP endpoint
  -- the message shapes and logic don't change.
- **No signing, no schema validation** -- ONIX's Signer and SchemaValidator
  plugins are not reproduced here. This demo proves the *participation
  logic* (discovery-only vs. full-transaction), not production security.

## What this proves, concretely

1. A `discover` reaches every registered node in a domain, regardless of type.
2. A **discovery-only** node answers `on_discover` but is explicitly rejected
   if a BAP tries `select`/`init`/`confirm` with it -- matching *"nodes
   participate exclusively for discovery or full transactions"* from the
   meeting notes.
3. A **full-transaction** node completes the whole lifecycle to a real,
   confirmed order.
4. UC1 and UC2 run on identical shared code -- only the domain data differs.
