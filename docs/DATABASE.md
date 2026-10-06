# State in PostgreSQL

sandbox-bap and sandbox-bpp keep their state in PostgreSQL, **one database per
service** (as in the A13 physical architecture): `naledi_bap` and `naledi_bpp`.
This replaces the JSON state files (`/data/bap-state.json`, `/data/bpp-state.json`).

## How it works

- Each app works on an in-memory copy of its state, exactly as before, so the
  request handling code did not change.
- **On every change** the app writes the rows that changed (inserts, updates and
  deletes) to its tables, in one database transaction. Writes never overlap: a
  change made during a write is written right after it.
- **On start** the app creates its tables if they are missing, loads them, and
  only then starts listening.
- **On stop** (`docker stop`, a restart, a new Azure revision) it finishes the
  last write before exiting. A hard crash loses at most the last few
  milliseconds of changes; this was tested with `kill -9` in the middle of a
  request (the pending request survived and the flow completed afterwards).
- If `DATABASE_URL` is not set, the apps fall back to the old JSON file
  (`STATE_FILE`), or to memory only. This is useful for quick local runs.

All the code is in `our-backend-naledi/db.js` (pool, table creation, row sync)
and in the `SCHEMA` / `TABLES` blocks at the top of `v1-bap.js` and `v1-bpp.js`.

## Tables

**naledi_bap** (buyer side, sandbox-bap)

| Table | One row per | Key columns |
|---|---|---|
| `transactions` | search started through `POST /v1/search` | `transaction_id`, `practitioner_id`, `need_type`, `region`, `status`, `order_status`, `need_id`, `provider_id`, `results`, `offers` (jsonb) |
| `outbox` | event for the partner's webhook | `event_id`, `seq` (delivery order), `event`, `transaction_id`, `payload`, `attempts`, `delivered`, `dead` |
| `tx_log` | log entry (see [LOGGING.md](LOGGING.md)) | `at`, `service`, `event`, `transaction_id`, `message_id`, `action`, `direction`, `data` |
| `meta` | setting | `epoch` |

**naledi_bpp** (provider side, sandbox-bpp)

| Table | One row per | Key columns |
|---|---|---|
| `providers` | entry in the provider directory (Impande, GROW, WeHelp, SmartStart, the Thabos) | `id`, `name`, `kind`, `need_types_covered`, `region`, `coverage`, `capacity`, `description` |
| `naledis` | practitioner | `id`, `name`, `region`, `need_ids` |
| `needs` | practitioner + need type | `id`, `naledi_id`, `type`, `status` (open, reserved, fulfilled), `provider_id`, `coach_id`, `note` |
| `pending_requests` | request waiting for the provider's decision | `id`, `seq`, `action` (select, init, confirm), `need_id`, `provider_id`, `context`, `message` |
| `tx_meta` | search seen by the provider side | `transaction_id`, `practitioner_id`, `need_type`, `provider_ids` (who matched), `discover_context`, `offers` |
| `outbox`, `tx_log`, `meta` | as above | `meta` also holds `snapshot` (true once the directory has been saved) |

`POST /v1/admin/reset` clears the working tables and increases `epoch`. It
keeps `tx_log`, so past rehearsals stay readable.

## Settings

| Variable | Example | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://naledi:pw@host:5432/naledi_bap?sslmode=require` | the app's own database |
| `PG_POOL_MAX` | `3` (default) | connections per app. The B1ms tier allows about 35 in total, so keep it at 3 to 5 |
| `PGSSLMODE` | `require` | TLS (Azure requires it); `sslmode=` in the URL does the same |
| `PGSSL_REJECT_UNAUTHORIZED` | `true` (default) | set `false` only if the server's certificate cannot be verified |

## Local (Docker)

Nothing to do: `./start.sh` now also starts `naledi-db` (PostgreSQL 16, internal
network only, data in the `naledi_pg` volume). It creates both databases the
first time, from `our-backend-naledi/db-init.sql`.

To look inside:

```bash
docker exec -it naledi-db psql -U naledi -d naledi_bpp -c "select id, type, status, provider_id from needs"
docker exec -it naledi-db psql -U naledi -d naledi_bap -c "select transaction_id, status, order_status from transactions"
```

To start completely fresh (this deletes all saved state):

```bash
./stop.sh && docker volume rm install_naledi_pg && ./start.sh
```

## Azure (Flexible Server)

1. On the PostgreSQL Flexible Server, create the two databases (portal →
   *Databases* → *Add*, or Azure Cloud Shell):

   ```bash
   az postgres flexible-server db create -g <resource-group> -s <server-name> -d naledi_bap
   az postgres flexible-server db create -g <resource-group> -s <server-name> -d naledi_bpp
   ```

2. Optional but recommended: one login per app, each allowed only its own
   database. Run in `psql` as the admin user:

   ```sql
   CREATE ROLE naledi_bap_app LOGIN PASSWORD '<strong password>';
   CREATE ROLE naledi_bpp_app LOGIN PASSWORD '<strong password>';
   GRANT ALL ON DATABASE naledi_bap TO naledi_bap_app;
   GRANT ALL ON DATABASE naledi_bpp TO naledi_bpp_app;
   \c naledi_bap
   GRANT ALL ON SCHEMA public TO naledi_bap_app;
   \c naledi_bpp
   GRANT ALL ON SCHEMA public TO naledi_bpp_app;
   ```

3. Put each connection string in Key Vault (or as a Container App secret), and
   set it on the container apps:

   | Container app | `DATABASE_URL` |
   |---|---|
   | sandbox-bap | `postgres://naledi_bap_app:<pw>@<server>.postgres.database.azure.com:5432/naledi_bap?sslmode=require` |
   | sandbox-bpp | `postgres://naledi_bpp_app:<pw>@<server>.postgres.database.azure.com:5432/naledi_bpp?sslmode=require` |

   Also set `PG_POOL_MAX=3`, and remove `STATE_FILE` and the file-share
   volume from both apps.

4. Deploy. On start each app logs `db.configured` and then `store.loaded`; the
   tables are created automatically.

The server has a private endpoint only, so use Azure Bastion (see the physical
architecture doc) for any `psql` maintenance.

## Moving existing state

Not needed for the demo: state is reset before every rehearsal anyway. If a
running deployment's state must be kept, say so before switching. The JSON
files map one to one onto the tables above, and a small import script can be
written.
