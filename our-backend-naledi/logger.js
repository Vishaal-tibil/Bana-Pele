// logger.js
//
// Structured logging for sandbox-bap and sandbox-bpp.
//
// Every log entry is ONE line of JSON on stdout, e.g.
//   {"ts":"2026-10-05T09:12:01.120Z","level":"info","service":"sandbox-bap",
//    "event":"beckn.out","transactionId":"...","messageId":"...","action":"discover",
//    "direction":"out","body":{...}}
//
// On Azure Container Apps, stdout goes to the environment's Log Analytics
// workspace (table ContainerAppConsoleLogs_CL), so these lines are persistent
// and can be queried by transactionId across all four services -- the onix
// adapters already log JSON with the same transactionId / messageId keys.
//
// Entries that belong to a transaction are ALSO written to the tx_log table
// when a database is configured, so GET /v1/log/{transactionId} survives
// restarts and shows both sides.
//
// Settings:
//   LOG_LEVEL        debug | info | warn | error   (default info)
//   LOG_BODY_LIMIT   max characters of a message body kept in a log entry
//                    (default 20000; the full Beckn messages are small)

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(service) {
  const min = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
  const bodyLimit = Number(process.env.LOG_BODY_LIMIT || 20000);
  let pool = null;
  let queue = [];
  let writing = false;

  function clip(body) {
    if (body === undefined) return undefined;
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    if (s.length <= bodyLimit) return body;
    return { truncated: true, length: s.length, head: s.slice(0, bodyLimit) };
  }

  function write(level, event, fields = {}) {
    if (LEVELS[level] < min) return;
    const { transactionId, messageId, action, direction, body, ...rest } = fields;
    const entry = {
      ts: new Date().toISOString(),
      level,
      service,
      event,
      ...(transactionId ? { transactionId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(action ? { action } : {}),
      ...(direction ? { direction } : {}),
      ...rest,
      ...(body !== undefined ? { body: clip(body) } : {}),
    };
    let line;
    try {
      line = JSON.stringify(entry);
    } catch (e) {
      line = JSON.stringify({ ts: entry.ts, level, service, event, error: 'unserialisable log entry' });
    }
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
    if (pool && transactionId) {
      queue.push(entry);
      if (queue.length > 5000) queue = queue.slice(-5000); // never grow without bound if the DB is down
      drain();
    }
  }

  // PostgreSQL refuses NUL characters in text and jsonb.
  const noNul = (v) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v);

  async function insert(batch) {
    const values = [];
    const params = [];
    batch.forEach((e, i) => {
      const { ts, level, service: svc, event, transactionId, messageId, action, direction, ...data } = e;
      const b = i * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb)`);
      params.push(ts, svc, level, event, noNul(transactionId) || null, noNul(messageId) || null, noNul(action) || null, direction || null,
        JSON.stringify(data).replace(/(?<!\\)\\u0000/g, ''));
    });
    await pool.query(
      `INSERT INTO tx_log (at, service, level, event, transaction_id, message_id, action, direction, data)
       VALUES ${values.join(',')}`,
      params
    );
  }

  function remove(done) {
    const gone = new Set(done);
    queue = queue.filter((e) => !gone.has(e));
  }

  // A PostgreSQL error code (SQLSTATE) means the server answered and refused
  // the data. Classes 08 / 53 / 57 are connection or resource problems, and
  // anything without a code is a network error: both are worth retrying.
  function refusedByDatabase(e) {
    const c = e && e.code;
    return typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) && !/^(08|53|57)/.test(c);
  }

  function warnDb(event, error) {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', service, event, error }) + '\n');
  }

  // Writes queued entries to tx_log in small batches, one batch at a time.
  async function drain() {
    if (writing || !pool) return;
    writing = true;
    try {
      while (queue.length) {
        const batch = queue.slice(0, 50);
        try {
          await insert(batch);
        } catch (e) {
          // Is the database down, or is one entry bad? Try the entries one by one.
          let wrote = 0;
          for (const entry of batch) {
            try {
              await insert([entry]);
              wrote += 1;
            } catch (e2) {
              if (!refusedByDatabase(e2)) throw e2; // the database is unreachable: retry later
              warnDb('log.entry_refused', e2.message); // the database refused this entry: drop it
            }
          }
        }
        remove(batch);
      }
    } catch (e) {
      warnDb('log.db_write_failed', e.message);
      setTimeout(drain, 2000);
    } finally {
      writing = false;
    }
  }

  async function readTx(transactionId) {
    if (!pool) return null;
    const r = await pool.query(
      `SELECT at, service, level, event, transaction_id, message_id, action, direction, data
         FROM tx_log WHERE transaction_id = $1 ORDER BY at, id`,
      [transactionId]
    );
    return r.rows.map((row) => ({
      at: row.at.toISOString(),
      service: row.service,
      level: row.level,
      event: row.event,
      transactionId: row.transaction_id,
      ...(row.message_id ? { messageId: row.message_id } : {}),
      ...(row.action ? { action: row.action } : {}),
      ...(row.direction ? { direction: row.direction } : {}),
      ...row.data,
    }));
  }

  return {
    debug: (event, f) => write('debug', event, f),
    info: (event, f) => write('info', event, f),
    warn: (event, f) => write('warn', event, f),
    error: (event, f) => write('error', event, f),
    // A Beckn message crossing between our app and its onix adapter.
    message(direction, payload, extra = {}) {
      const c = (payload && payload.context) || {};
      write('info', direction === 'out' ? 'beckn.out' : 'beckn.in', {
        transactionId: c.transactionId,
        messageId: c.messageId,
        action: c.action,
        direction,
        ...extra,
        body: payload,
      });
    },
    attachDb(p) {
      pool = p;
      drain();
    },
    readTx,
    flush: async () => {
      for (let i = 0; i < 50 && (queue.length || writing); i++) {
        if (!writing) drain();
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

module.exports = { createLogger };
