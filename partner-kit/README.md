# Joining the network: quickstart for your backend

You have an Express backend. I run the network. This kit is the small piece
that connects the two: **copy one folder, add about ten lines, set two
environment variables, deploy.** With the variables unset the kit does nothing,
so your demo can never break because of it.

```
partner-kit/
  network-kit/index.js        <- the only thing you copy into your project
  examples/reference-app.js   <- a working example shaped like your demo server (read this)
  README.md                   <- this file
```

Node 18+ and Express 4+. No other dependencies.

## 1. Copy the kit

Copy `network-kit/` into your backend project (for example next to `app.js`).

## 2. Two environment variables

| Variable | Value |
|---|---|
| `NETWORK_BASE_URL` | the address I send you, for example `https://example.trycloudflare.com` |
| `NETWORK_API_KEY` | the key I send you (privately). It is also the key you check on the two endpoints below. |

On Cloud Run: set them on the service, and set **minimum instances to 1** (so a
cold start never makes an event or lookup time out).

## 3. Wire it in (about ten lines)

```js
const { networkRouter, networkClient, matchOrgProfile } = require('./network-kit');

const net = networkClient({ baseUrl: process.env.NETWORK_BASE_URL, apiKey: process.env.NETWORK_API_KEY });

// The two endpoints the network calls on you. Mount them under your API prefix,
// so they answer at  /api/v1/network/match  and  /api/v1/network/events.
app.use('/api/v1', networkRouter({
  apiKey: process.env.NETWORK_API_KEY || 'network-off',
  match:   async (q) => matchOrgProfile(q, store.orgProfile),   // your own rule, or use this ready-made one
  onEvent: async (e) => handleNetworkEvent(e),                  // see the table in step 4
}));
```

Then call `net` from the handlers you already have. `net` never throws; when it
fails (or is switched off) it returns `{ ok: false }`, and you carry on with
your own logic, as the example does.

| Your existing handler | Add this call | What comes back later (an event) |
|---|---|---|
| `POST /practitioners/signup` | `net.search({ practitionerId, needType: 'registration', region, tier, children })` and keep `data.transactionId` on her record | `practitioner.matched` -> create WeHelp's "New Practitioner Onboarded" item |
| `POST /offers` | `net.offer({ transactionId, providerId: 'provider-wehelp', title, area, note, offerId: <your own offer id> })` | `offer.received` -> now show the offer to Naledi |
| `POST /offers/{id}/accept` | `net.select({ transactionId, practitionerId, needType: 'registration', providerId: 'provider-wehelp' })` | `request.received` (`select_init`) |
| `POST /offers/{id}/assign` | `net.decision({ transactionId, decision: 'accept', coachId })` | `status.changed` `reserved` |
| `POST /offers/{id}/complete` | `net.confirm({ ... })` then `net.complete({ transactionId })` | `status.changed` `fulfilled` |

`examples/reference-app.js` does all of this against the same endpoint names as
your `openapi.v2.yaml`; the places that use the kit are marked `NETWORK:` and
`FALLBACK`.

## 4. Handle the events

`onEvent(e)` is called once per event (the kit skips repeats for you). `e` looks
like:

```json
{ "eventId": "...", "event": "status.changed", "epoch": 3, "transactionId": "...",
  "practitionerId": "prac_naledi_mahlangu", "providerId": "provider-wehelp",
  "status": "reserved", "payload": { "needId": "...", "from": "pending" } }
```

| `event` | `status` | Do this |
|---|---|---|
| `practitioner.matched` | `matched` | create the "New Practitioner Onboarded" work item (`payload.reasons` are the reasons to show) |
| `offer.received` | `offered` | mark the offer with id `payload.offerId` as delivered to Naledi |
| `request.received` | `awaiting_decision` | `payload.stage` is `select_init` (Naledi asked) or `confirm` (completion asked): show it to WeHelp |
| `status.changed` | `reserved`, `fulfilled`, `rejected` | move the case forward (or back, for `rejected`) |

**One rule that avoids a nasty bug:** an event can arrive *before* the HTTP
response of the call that caused it. So match events to your data with ids you
already hold (`transactionId`, and the `offerId` you chose yourself), never with
an id that only comes back in a response.

If your handler throws, the kit answers 500 and I send the event again later, so
make handlers safe to run twice.

## 5. Check it, then tell me your address

```bash
URL=https://<your-service>/api/v1
KEY=<the key>

curl $URL/network/health
# -> {"ok":true}

curl -H "X-Api-Key: $KEY" "$URL/network/match?needType=registration&region=Alexandra&tier=Pre-Bronze&children=28"
# -> {"matches":[{"providerId":"provider-wehelp", ...}]}

curl -X POST -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d '{"eventId":"t1","event":"ping"}' $URL/network/events
# -> {"ok":true}
```

Send me `https://<your-service>/api/v1`. On my side one command connects and
checks everything (`./connect.sh <that address>`).

## Try it on your laptop first

```bash
cd partner-kit
npm install
NETWORK_BASE_URL=<my address> NETWORK_API_KEY=<key> node examples/reference-app.js
# then drive it like your own app: POST /api/v1/practitioners/signup, /offers, /offers/{id}/accept ...
```

## Rules of the road

- Keep your service at one instance and don't redeploy during a demo.
- `POST /api/v1/admin/reset` in the example resets both sides; use the same idea
  before each rehearsal (the events carry an `epoch` that changes on reset).
- The network uses shared test identities for now: use only made-up data.
