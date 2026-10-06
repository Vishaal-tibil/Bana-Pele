# Sharing the /v1 API with the Bana Pele team

What to send, and how to issue the sandbox key.

## What to send

| Item | File | How |
|---|---|---|
| API spec (machine-readable) | [`v1-openapi.yaml`](v1-openapi.yaml) | Attach it, or share the repo link. It opens in [Swagger Editor](https://editor.swagger.io) (File → Import) or Postman (Import). |
| API guide (the flow, events, button mapping, rules) | [`../PARTNER-CONTRACT.md`](../PARTNER-CONTRACT.md) | Attach or link |
| needType list | the table below (also in both files above) | In the message |
| Drop-in kit for their Express app (optional) | [`../../partner-kit/`](../../partner-kit/) | Zip the folder |
| **Base URL** | the naledi-edge address | **Privately** |
| **Sandbox API key** | see below | **Privately**, never in a shared channel or email |

## needType values

The network understands these ten. The second column shows who answers each
one in the sandbox provider directory (sandbox-bpp), when no partner match
service is connected.

| `needType` | Sandbox providers |
|---|---|
| `registration` | Impande (NGO), Registration Guide Thabo (Thabo), WeHelp (NGO) |
| `infrastructure` | WeHelp (NGO) |
| `learning-skilling` | WeHelp (NGO) |
| `health-safety` | WeHelp (NGO) |
| `nutrition` | WeHelp (NGO) |
| `child-development` | WeHelp (NGO) |
| `starter-kit` | SmartStart (NGO) |
| `capability-development` | Capability Development Thabo (Thabo) |
| `fundraising` | GROW (NGO), Fundraising Thabo (Thabo) |
| `peer-guidance` | Peer Naledi Guide (Thabo) |

WeHelp's area is Alexandra (it also covers Johannesburg and Gauteng); the
others are in Gauteng. Any other `needType` value is accepted by `/v1/search`,
but nothing will match it.

## Issuing the sandbox API key

The key is one shared secret: they send it in `X-Api-Key` when calling us,
and we send the same header when calling their `/network/*` endpoints. Use a
**separate** key for the sandbox; do not reuse the local demo key
(`demo-key-change-me`) or the key from your laptop's `.env`.

1. Create a strong key, on your own machine:

   ```bash
   openssl rand -hex 24
   ```

2. Set it on the sandbox deployment as `API_KEY`, on **both** sandbox-bap and
   sandbox-bpp, since sandbox-bpp uses the same key for its internal endpoints.
   On Azure, store it as a Container App secret (or in Key Vault) and point the
   `API_KEY` environment variable at that secret. Then restart both apps.
   Locally: edit `API_KEY=` in
   `~/starter-kit/generic-devkit/install/.env`, then `bash start.sh`.

3. Check it works through the edge:

   ```bash
   curl -s https://<edge-address>/v1/health                                   # {"ok":true,...}
   curl -s -o /dev/null -w "%{http_code}\n" https://<edge-address>/v1/status/x                     # 401
   curl -s -o /dev/null -w "%{http_code}\n" -H "X-Api-Key: <key>" https://<edge-address>/v1/status/x   # 404 (key accepted)
   ```

4. Send the key and the base URL privately (a password manager share, or a
   direct message that you delete afterwards).

To rotate it later, repeat steps 1 to 4 and tell them the new key at the same
time.

## Message you can send

> Hi team, here is the Naledi network /v1 API for the sandbox:
>
> - Spec: `docs/api/v1-openapi.yaml` (OpenAPI 3; import into Swagger Editor or Postman)
> - Guide: `docs/PARTNER-CONTRACT.md` (flow, the events we push to you, button mapping)
> - needType values: registration, infrastructure, learning-skilling, health-safety,
>   nutrition, child-development, starter-kit, capability-development, fundraising,
>   peer-guidance
>
> I'll send the base URL and your sandbox API key to you directly. Every call needs
> the header `X-Api-Key`, except `GET /v1/health`.
