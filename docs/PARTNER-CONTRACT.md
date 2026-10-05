# Connecting your backend to the network

I run the network side (the real Beckn adapters, message formats, signing,
routing). You run the business side (profiles, matching rules, offers, cases,
screens). We talk through a small REST contract, described here. Every format
below is what my side actually sends and accepts today.

## How the offer works

The network starts from the person who needs help, so WeHelp's offer is a
response to Naledi's own signup:

1. When Naledi signs up, you call me. I send her need into the network, using
   only the fields she agreed to share.
2. The network reaches WeHelp's side. I ask you whether WeHelp matches. If yes,
   I tell you, and you create the "New Practitioner Onboarded" item.
3. When WeHelp clicks Send Offer, you call me and I send the offer back to
   Naledi's side as a second response on the same search. You show it in her
   Support Offers tab.
4. When Naledi accepts, you call me. The request goes through the network to
   WeHelp's side, and I tell you.
5. When WeHelp assigns a coach, you call me with the decision.
6. When the support is completed, you call me to confirm, and again with the
   final decision. The network marks it fulfilled.

The exact request and response formats are also in machine-readable form:
[api/v1-openapi.yaml](api/v1-openapi.yaml) (OpenAPI 3; it opens in Swagger
Editor or Postman).

## Address and key

- Base URL: `https://<address I send you>` (paths below start with `/v1`).
- Every call in both directions carries the header `X-Api-Key: <key>`. I send
  you the key privately. I send the same header when I call you.
- All bodies are JSON.

## What I provide (you call me)

| Call | When you call it | Body | Returns |
|---|---|---|---|
| `POST /v1/search` | Naledi signs up | `{ practitionerId, needType, region, tier, children }` | `202 { transactionId, status: "searching" }` |
| `GET /v1/results/{transactionId}` | any time | none | providers found and offers received |
| `GET /v1/status/{transactionId}` | any time | none | current status and details |
| `GET /v1/log/{transactionId}` | support / debugging | none | every message and state change on both sides, in time order |
| `POST /v1/provider/offer` | WeHelp clicks Send Offer | `{ transactionId, providerId, title, area, note, offerId }` (send **your own** offer id) | `200 { offerId, status: "sent" }` |
| `POST /v1/select` | Naledi accepts the offer | `{ transactionId, practitionerId, needType, providerId }` | `202 { status: "pending" }` |
| `POST /v1/provider/decision` | WeHelp accepts or declines (and assigns a coach) | `{ transactionId, decision: "accept" or "decline", coachId }` | `200 { needStatus }` |
| `POST /v1/confirm` | Naledi confirms | `{ transactionId, practitionerId, needType, providerId, note }` | `202 { status: "confirming" }` |
| `POST /v1/provider/complete` | WeHelp marks the support delivered | `{ transactionId }` | `200 { needStatus: "fulfilled" }` |
| `POST /v1/admin/reset` | between rehearsals | none | `{ epoch }` |
| `GET /v1/health` | monitoring (no key needed) | none | `{ ok, epoch, outboxPending }` |

`needType` values: `registration`, `infrastructure`, `learning-skilling`,
`health-safety`, `nutrition`, `child-development`, `starter-kit`,
`capability-development`, `fundraising`, `peer-guidance`.

`providerId` for WeHelp is `provider-wehelp`. `practitionerId` and `coachId` are
whatever ids you use (for example `prac_naledi_mahlangu`, `coach_thabo_nkosi`).
`transactionId` comes back from `/v1/search`; keep it on Naledi's record and use
it for every later call. An offer needs a search where WeHelp matched.

### Statuses (`GET /v1/status`)

`searching`, `results_ready`, `pending` (waiting for WeHelp), `reserved`
(WeHelp accepted), `confirming`, `fulfilled`, `rejected` (declined, or the need
was already taken), `error` (the network refused the message).

### Errors

| Code | Meaning |
|---|---|
| 400 `invalid_request` | a required field is missing |
| 401 `unauthorized` | missing or wrong `X-Api-Key` |
| 404 `unknown_transaction` / `no_pending_request` | nothing to act on |
| 409 `already_in_progress` / `not_reserved` / `provider_not_matched` / `request_not_ready` | the step is not allowed right now |
| 502 `network_rejected` | the network refused the message; `detail` says why |

Repeating `select` or `confirm` for the same transaction is safe: the second
call returns 200 with `idempotent: true`.

## What you build (I call you)

### 1. `GET /network/match`

Query: `needType`, `region`, `practitionerId`, `tier`, `children`.
Tell me whether WeHelp matches this practitioner (area, tier, capability,
number of children). Answer within 3 seconds; if you don't, I treat it as "no
match".

```json
{ "matches": [ {
    "providerId": "provider-wehelp",
    "name": "WeHelp",
    "kind": "NGO",
    "description": "Registration guidance, DSD submission support and infrastructure help.",
    "region": "Alexandra",
    "reasons": ["Within your service area", "registration is one of your support capabilities", "Eligible tier"]
} ] }
```

An empty list (`{ "matches": [] }`) means no match.

### 2. `POST /network/events`

I push events here. Answer with any 2xx code, quickly. Body:

```json
{
  "eventId": "96537456-a72e-4ace-8136-5d3665361208",
  "at": "2026-09-28T17:16:12.320Z",
  "event": "practitioner.matched",
  "epoch": 14,
  "transactionId": "34d36803-11dd-44b8-9091-c466f85d20f0",
  "practitionerId": "prac_naledi_mahlangu",
  "providerId": "provider-wehelp",
  "status": "matched",
  "payload": { "needType": "registration", "region": "Alexandra", "tier": "Pre-Bronze", "children": 28, "reasons": ["..."] }
}
```

| `event` | Meaning | `status` | Useful `payload` |
|---|---|---|---|
| `practitioner.matched` | a new practitioner matches WeHelp | `matched` | `needType`, `region`, `tier`, `children`, `reasons` |
| `offer.received` | the offer reached Naledi's side | `offered` | `offerId`, `title`, `area`, `note`, `providerName` |
| `request.received` | Naledi's request reached WeHelp | `awaiting_decision` | `stage` is `select_init` or `confirm`, plus `needId`, `needType` |
| `status.changed` | the request moved on | `reserved`, `fulfilled` or `rejected` | `needId`, `from` |

Rules for the webhook:

- **An event can arrive before the response of the call that caused it.** Match events
  to your data with ids you already hold (`transactionId`, and the `offerId` you
  sent yourself), never with an id that only comes back in a response.
- I deliver events in order, and retry with a growing pause (1 s, 2 s, 4 s ...
  up to 30 s, at most 20 tries) if you are down or slow. A retry carries the
  same `eventId`, so **ignore an `eventId` you have already handled**.
- Events I could not deliver wait in a saved queue, so a restart on my side does
  not lose them.
- `epoch` changes when I reset. If it changes, drop the network state you hold.

## How your buttons map

| Your action | You call |
|---|---|
| Naledi signs up | `POST /v1/search` |
| Event `practitioner.matched` arrives | create the "New Practitioner Onboarded" item for WeHelp |
| WeHelp clicks Send Offer | `POST /v1/provider/offer` |
| Event `offer.received` arrives | show the offer in Naledi's Support Offers tab |
| Naledi accepts | `POST /v1/select` |
| Event `request.received` (`select_init`) arrives | show "awaiting assignment" for WeHelp |
| WeHelp assigns a coach | `POST /v1/provider/decision` with `coachId` |
| Event `status.changed` (`reserved`) arrives | mark Assigned |
| Naledi confirms | `POST /v1/confirm` |
| Event `request.received` (`confirm`) arrives | WeHelp sees the completion request |
| WeHelp completes | `POST /v1/provider/complete` |
| Event `status.changed` (`fulfilled`) arrives | mark Completed and update Naledi's coverage |

## Rules

- Keep your service at one running instance, with the minimum instances set to 1
  so it never starts cold, and do not redeploy during the demo.
- Your two endpoints must be reachable from the internet over HTTPS.
- Reset both sides together before each rehearsal: your own reset and my
  `POST /v1/admin/reset`.
- If a call to me fails, let your app carry on with its own logic.
- The network uses shared test identities for now, so use only made-up data. The
  `note` on `/v1/confirm` stays in my record and does not travel through the
  network.

## How we connect

1. We agree this contract and the field names.
2. You add the drop-in kit from `partner-kit/` (copy one folder, about ten lines, two
   environment variables; see [partner-kit/README.md](../partner-kit/README.md)), or build the two endpoints and
   the calls yourself from this contract. I have a working reference app and a full
   test suite on my side, so I can test against your real URLs the moment they exist.
3. I send you the address and key privately, and you send me your two URLs and
   key.
4. We run signup, offer, accept, assign and complete together.
5. We rehearse on the venue network.

Done when: each step shows up in my network logs, your screens update within a
few seconds, and your app still works with my side switched off.
