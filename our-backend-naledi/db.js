// db.js
//
// PostgreSQL access for the two Naledi apps. Each app has its own database
// (sandbox-bap -> naledi_bap, sandbox-bpp -> naledi_bpp), set with
// DATABASE_URL. Without DATABASE_URL nothing here is used and the apps keep
// the old JSON state file (handy for quick local runs).
//
//   DATABASE_URL   postgres://user:password@host:5432/naledi_bap?sslmode=require
//   PG_POOL_MAX    connections per app (default 3 -- the Azure B1ms tier allows
//                  only ~35 in total, see the physical architecture doc)
//   PGSSLMODE      "require" also turns TLS on (Azure needs it)
//
// The apps work on an in-memory copy of their state (the code is synchronous
// over plain objects and Maps). The tables are the durable copy: every save
// writes the rows that changed since the last save, inside one transaction,
// and every start loads the tables back into memory.

'use strict';

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  // pg is only needed when DATABASE_URL is set; reported in openPool().
}

// ---- connection ----

function openPool(log) {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) return null;
  if (!Pool) throw new Error('DATABASE_URL is set but the "pg" package is not installed (npm install)');
  const url = new URL(raw);
  const mode = url.searchParams.get('sslmode') || process.env.PGSSLMODE || '';
  url.searchParams.delete('sslmode'); // TLS is configured explicitly below
  const ssl = ['require', 'verify-ca', 'verify-full'].includes(mode)
    ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' }
    : false;
  const pool = new Pool({
    connectionString: url.toString(),
    ssl,
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (e) => log.error('db.pool_error', { error: e.message }));
  log.info('db.configured', { host: url.hostname, database: url.pathname.slice(1), ssl: !!ssl, poolMax: pool.options.max });
  return pool;
}

async function migrate(pool, statements) {
  // One advisory lock per database, so two copies starting at once do not race.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

// Shared by both apps.
const COMMON_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   text PRIMARY KEY,
     value jsonb NOT NULL
   )`,
  // Events pushed to the partner's webhook (the outbox).
  `CREATE TABLE IF NOT EXISTS outbox (
     event_id        uuid PRIMARY KEY,
     seq             bigint NOT NULL,
     at              timestamptz NOT NULL,
     event           text NOT NULL,
     epoch           integer NOT NULL,
     transaction_id  text,
     practitioner_id text,
     provider_id     text,
     status          text,
     payload         jsonb NOT NULL DEFAULT '{}',
     attempts        integer NOT NULL DEFAULT 0,
     next_at         bigint NOT NULL DEFAULT 0,
     delivered       boolean NOT NULL DEFAULT false,
     local_only      boolean NOT NULL DEFAULT false,
     dead            boolean NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS outbox_seq ON outbox (seq)`,
  // One structured log per transaction: every message in and out and every
  // state change (see logger.js). Append-only.
  `CREATE TABLE IF NOT EXISTS tx_log (
     id             bigserial PRIMARY KEY,
     at             timestamptz NOT NULL,
     service        text NOT NULL,
     level          text NOT NULL,
     event          text NOT NULL,
     transaction_id text,
     message_id     text,
     action         text,
     direction      text,
     data           jsonb NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS tx_log_tx ON tx_log (transaction_id, at)`,
];

// PostgreSQL refuses the NUL character in text and jsonb; drop it.
const NUL_ESCAPE = /(?<!\\)\\u0000/g; // the JSON escape \u0000 (not an escaped backslash before it)
function clean(v) {
  return typeof v === 'string' ? v.replace(/\u0000/g, '') : v;
}
function jsonText(v) {
  return JSON.stringify(v).replace(NUL_ESCAPE, '');
}

// ---- generic row sync ----
//
// tables: { name: { pk: 'col', cols: ['col', ...], json: ['col', ...] } }
// toRows(state)  -> { name: [row, ...] }      (row = { col: value })
// fromRows(rows) -> applies { name: [row, ...] } onto the state

function createSync({ pool, tables, toRows, fromRows, log, name }) {
  const written = {}; // table -> Map(pk -> JSON of the row last written)
  for (const t of Object.keys(tables)) written[t] = new Map();
  let loaded = false; // nothing is written before the tables have been read

  async function load() {
    const rows = {};
    for (const [t, def] of Object.entries(tables)) {
      const r = await pool.query(`SELECT ${def.cols.join(', ')} FROM ${t}${def.order ? ` ORDER BY ${def.order}` : ''}`);
      rows[t] = r.rows;
      for (const row of r.rows) written[t].set(String(row[def.pk]), JSON.stringify(normalise(def, row)));
    }
    fromRows(rows);
    loaded = true;
    return rows;
  }

  // Values as they go into the database (jsonb columns as JSON text).
  function normalise(def, row) {
    const out = {};
    for (const c of def.cols) {
      let v = row[c] === undefined ? null : row[c];
      if (v instanceof Date) v = v.toISOString();
      if (def.json && def.json.includes(c)) v = v === null ? null : jsonText(v);
      out[c] = clean(v);
    }
    return out;
  }

  async function syncOnce() {
    const all = toRows();
    const ops = [];
    const next = {};
    for (const [t, def] of Object.entries(tables)) {
      const seen = new Map();
      for (const row of all[t] || []) {
        const n = normalise(def, row);
        const key = String(n[def.pk]);
        const j = JSON.stringify(n);
        seen.set(key, j);
        if (written[t].get(key) !== j) ops.push({ t, def, kind: 'upsert', n });
      }
      for (const key of written[t].keys()) if (!seen.has(key)) ops.push({ t, def, kind: 'delete', key });
      next[t] = seen;
    }
    if (ops.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const op of ops) {
          // One savepoint per row: a row the database refuses is logged and
          // skipped, instead of blocking every later save.
          await client.query('SAVEPOINT row_op');
          try {
            if (op.kind === 'delete') {
              await client.query(`DELETE FROM ${op.t} WHERE ${op.def.pk} = $1`, [op.key]);
            } else {
              const cols = op.def.cols;
              const params = cols.map((c, i) => `$${i + 1}`);
              const updates = cols.filter((c) => c !== op.def.pk).map((c) => `${c} = EXCLUDED.${c}`);
              await client.query(
                `INSERT INTO ${op.t} (${cols.join(', ')}) VALUES (${params.join(', ')})
                 ON CONFLICT (${op.def.pk}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`,
                cols.map((c) => op.n[c])
              );
            }
            await client.query('RELEASE SAVEPOINT row_op');
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT row_op');
            log.error('db.row_refused', { store: name, table: op.t, op: op.kind, key: op.kind === 'delete' ? op.key : op.n[op.def.pk], error: e.message });
            // Treated as written: it is tried again only when the row changes.
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
    for (const t of Object.keys(tables)) written[t] = next[t];
    return ops.length;
  }

  // save() never runs two writes at once: a save requested during a write
  // runs once more right after it, with the newest state.
  let running = null;
  let again = false;
  let retryTimer = null;
  function save() {
    if (!loaded) return Promise.resolve(); // never overwrite tables we have not read
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await syncOnce();
        } catch (e) {
          log.error('db.save_failed', { store: name, error: e.message });
          if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; save(); }, 2000);
          break;
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { load, save, flush: () => (running || Promise.resolve()) };
}

// ---- helpers for mappers ----

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

module.exports = { openPool, migrate, createSync, COMMON_SCHEMA, iso };
