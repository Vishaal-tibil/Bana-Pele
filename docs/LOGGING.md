# Structured, persistent logging

One log per transaction, across all four network services: every message in
and out, and every state change. This replaces the short in-memory history
behind `GET /v1/log/{transactionId}`.

## What is logged, and where it goes

| Service | Format | Where it is kept |
|---|---|---|
| sandbox-bap, sandbox-bpp (our code) | one JSON line per event on stdout ([logger.js](../our-backend-naledi/logger.js)) | Log Analytics (via Container Apps), **and** the `tx_log` table in the app's own database |
| onix-bap, onix-bpp (official adapters, unmodified) | their own JSON lines on stdout (`log:` section of `generic-bap.yaml` / `generic-bpp.yaml`: level `debug`, `contextKeys: transactionId, messageId`) | Log Analytics (via Container Apps) |

Every line carries the **transaction id**, so one query shows the whole
journey across all four services. Our apps write it as `transactionId`, and
the adapters write it as `transaction_id`.

The signed messages themselves, with their `Authorization` signature header,
exist only between the two adapters. The adapters log each message they
receive and forward (`"message":"HTTP Request"`, with the body), and whether
schema validation and signing passed. Our apps log the same message as it
leaves for or arrives from the adapter (`beckn.out` / `beckn.in`), plus the
adapter's ACK or NACK (`beckn.ack`).

## Our log line

```json
{"ts":"2026-10-05T06:26:13.447Z","level":"info","service":"sandbox-bap","event":"beckn.out",
 "transactionId":"a3126188-...","messageId":"5be1...","action":"discover","direction":"out",
 "to":"onix-bap","body":{"context":{...},"message":{...}}}
```

| `event` | Service | Meaning |
|---|---|---|
| `beckn.out` / `beckn.in` | both | a Beckn message sent to / received from our adapter (full body) |
| `beckn.ack` | both | the adapter's answer to what we sent: `ack` is `ACK` or `NACK`, plus `httpStatus` |
| `beckn.send_failed` | both | the adapter could not be reached |
| `tx.state` | bap | a transaction changed: `text` (e.g. "select requested", "received on_init"), `status`, `orderStatus` |
| `match.result` / `match.lookup_failed` | bpp | who matched a search (partner lookup or built-in directory) |
| `need.created`, `need.status_changed` | bpp | a need appeared, or moved `open → reserved → fulfilled` (with `from`, `to`) |
| `request.rejected` | bpp | a select/confirm was refused (need already taken) |
| `provider.decision`, `offer.sent` | bpp | the provider accepted or declined (and the coach), or sent an offer |
| `event.queued`, `event.delivered`, `event.delivery_failed` | both | events for the partner's webhook (`eventName`, `attempt`) |
| `api.request` | bap | each `/v1` call: `method`, `path`, `status`, `ms` |
| `admin.reset`, `store.loaded`, `store.restored`, `server.listening`, `server.stopping`, `db.*` | both | operations |

Settings: `LOG_LEVEL` (`debug`, `info` default, `warn`, `error`) and
`LOG_BODY_LIMIT` (default 20000 characters per message body).

## Reading one transaction's log

**From the API** (both of our apps, from the database, survives restarts):

```bash
curl -s -H "X-Api-Key: $API_KEY" http://localhost:3010/v1/log/<transactionId>
```

**Locally from Docker** (all four services):

```bash
TX=<transactionId>
for c in sandbox-bap onix-bap onix-bpp sandbox-bpp; do docker logs $c 2>&1 | grep "$TX" | sed "s/^/[$c] /"; done
```

**From the database:**

```bash
docker exec -it naledi-db psql -U naledi -d naledi_bap -c \
  "select at, event, action, data->>'text' from tx_log where transaction_id = '<transactionId>' order by at"
```

## Log Analytics (Azure)

Container Apps sends each container's stdout to the environment's Log
Analytics workspace. Nothing extra is needed in the code. Check that the
Container Apps environment has *Logs destination = Azure Log Analytics*, and set
the workspace retention (default 30 days) to what the demo needs.

The table name depends on how logging was set up:
`ContainerAppConsoleLogs_CL` (columns `ContainerAppName_s`, `Log_s`) for the
default destination, or `ContainerAppConsoleLogs` (columns `ContainerAppName`,
`Log`) when it goes through diagnostic settings. The queries below use the
first form. Also replace the container app names if yours differ.

**The whole journey of one transaction, all four services:**

```kusto
let tx = "<transactionId>";
ContainerAppConsoleLogs_CL
| where ContainerAppName_s in ("sandbox-bap", "sandbox-bpp", "onix-bap", "onix-bpp")
| where Log_s has tx
| extend j = parse_json(Log_s)
| extend event = coalesce(tostring(j.event), tostring(j.message)),
         action = tostring(j.action),
         level = tostring(j.level)
| project TimeGenerated, ContainerAppName_s, level, event, action, Log_s
| order by TimeGenerated asc
```

**Every NACK, schema rejection or delivery failure in the last day:**

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1d)
| where ContainerAppName_s in ("sandbox-bap", "sandbox-bpp", "onix-bap", "onix-bpp")
| where Log_s has_any ("\"NACK\"", "is unsupported", "validation failed", "\"level\":\"error\"", "delivery_failed", "send_failed")
| project TimeGenerated, ContainerAppName_s, Log_s
| order by TimeGenerated desc
```

**State changes only (one line per step of each need):**

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s in ("sandbox-bap", "sandbox-bpp")
| extend j = parse_json(Log_s)
| where tostring(j.event) in ("tx.state", "need.status_changed", "provider.decision", "offer.sent")
| project TimeGenerated, service = tostring(j.service), tx = tostring(j.transactionId),
          event = tostring(j.event), text = tostring(j.text), from_ = tostring(j.from), to_ = tostring(j.to)
| order by TimeGenerated asc
```

## Notes

- Message bodies are logged in full (up to `LOG_BODY_LIMIT`). The network uses
  made-up demo data only. Before real personal data flows, decide what
  must be masked.
- `tx_log` is append-only and is not cleared by `/v1/admin/reset`. At demo volume
  it stays small; add a clean-up job (for example, delete entries older than 30
  days) before any long-running use.
- If the database is down, log lines still go to stdout, and database writes
  are retried (up to 5,000 entries are held).
