"""
Real-protocol sketch -- same NGO-support story as domains/ngo_support.py and
shared/network.py, but here Registry, Gateway, BAP and every BPP are separate
HTTP services (separate OS processes, separate ports) exchanging real Beckn-
shaped context/action envelopes, with a genuine sync-ACK + async-callback
pattern instead of in-process function calls.

See real_protocol/README.md for what's real here vs. what's still simplified.
"""
