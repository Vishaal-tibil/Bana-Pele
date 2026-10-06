# Dev/staging on Azure Container Apps (task 6.4)

Moves the stack off Docker/WSL laptops into the `cae-naledi` environment.
One script does it: [`tools/azure/deploy.sh`](../tools/azure/deploy.sh).

## Layout

| Piece | Azure resource |
|---|---|
| edge, sandbox-bap, sandbox-bpp, onix-bap, onix-bpp, redis | one container app `naledi-stack`, six containers on localhost, **1 replica** |
| Public address | the app's HTTPS ingress → edge :3010 → `/v1/*` only |
| State | PostgreSQL flexible server (B1ms), databases `naledi_bap`, `naledi_bpp` |
| Adapter configs + Caddyfile | Azure Files share `naledi-config`, mounted read-only |
| Images | ACR: `naledi-bap`, `naledi-bpp` built from `our-backend-naledi`; onix/redis/caddy mirrored |
| Secrets | container-app secrets (API key, internal key, DB URLs); move to Key Vault later |
| Logs | stdout JSON → the environment's Log Analytics (`ContainerAppConsoleLogs_CL`) plus `tx_log` table |

Why one app: the containers keep the ports they have in Docker, so the adapter
configs only need host names changed to `localhost` (the script does it on a
copy) and no VNet/TCP ingress is needed. Why one replica: each app keeps its
state in memory and syncs it to Postgres; two copies would overwrite each
other.

## Run (SRE, needs rights on the resource group)

```bash
az login
RG=<resource-group> CONFIG_DIR=~/starter-kit/generic-devkit/config bash tools/azure/deploy.sh
```

Optional: `MATCH_URL`, `EVENTS_URL` (partner), `BAP_ID`/`BPP_ID` (after 6.7),
`ENV_NAME` (default `cae-naledi`), `CREATE_ENV=1 LOCATION=<region>` if the
environment does not exist. Re-running redeploys with a new image tag.
Generated secrets are kept in `~/.naledi-azure-secrets` on the machine that ran it.

At the end it prints the base URL; then:

```bash
BASE=https://<fqdn> API_KEY=<key> bash try-all-apis.sh
```

(`tests/e2e.js` needs the internal ports, so it stays a local test.)

## Not done yet

- Custom domain and certificate for the edge.
- Key Vault references instead of plain container-app secrets; managed
  identity for ACR pulls instead of the admin user.
- Public `/bap/receiver` and `/bpp/receiver` (only needed when nodes outside
  this app talk to us; goes with 6.7).
- CI (GitHub Actions) calling the same script on merge to `Network`.
