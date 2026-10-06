// Unit test for the single-writer guard in our-backend-naledi/db.js.
// Uses a fake pool, so it runs without PostgreSQL:
//   node --test tests/writer-lock.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { acquireWriterLock, WRITER_LOCK_KEY } = require(path.join(__dirname, '..', 'our-backend-naledi', 'db.js'));

function fakePool(lockAnswer) {
  const calls = [];
  let released = 0;
  const pool = {
    calls,
    get released() { return released; },
    async connect() {
      return {
        async query(sql, params) {
          calls.push({ sql, params });
          if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: lockAnswer }] };
          throw new Error('unexpected query: ' + sql);
        },
        on() {},
        release() { released += 1; },
      };
    },
  };
  return pool;
}

const log = { info() {}, error() {}, warn() {} };

test('first instance takes the lock and keeps its client', async () => {
  const pool = fakePool(true);
  const client = await acquireWriterLock(pool, log);
  assert.ok(client, 'returns the held client');
  assert.equal(pool.released, 0, 'the held client is not released');
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params, [WRITER_LOCK_KEY]);
});

test('second instance is refused and its client is released', async () => {
  const pool = fakePool(false);
  await assert.rejects(
    () => acquireWriterLock(pool, log),
    /single-writer lock held/
  );
  assert.equal(pool.released, 1, 'the refused client goes back to the pool');
});

test('losing the lock connection is logged and stops the process (onLost)', async () => {
  let handler = null;
  const logged = [];
  const pool = {
    async connect() {
      return {
        async query() { return { rows: [{ ok: true }] }; },
        on(event, fn) { if (event === 'error') handler = fn; },
        release() {},
      };
    },
  };
  const spyLog = { info() {}, warn() {}, error(event, fields) { logged.push({ event, fields }); } };
  let stopped = null;
  await acquireWriterLock(pool, spyLog, (e) => { stopped = e; });
  assert.ok(handler, 'an error handler is attached to the lock connection');
  const cut = new Error('terminating connection due to administrator command');
  handler(cut);
  assert.equal(logged[0].event, 'db.writer_lock_lost');
  assert.equal(stopped, cut, 'onLost receives the error and the process is stopped');
});

test('a database error while locking is passed up and the client is released', async () => {
  const pool = {
    async connect() {
      return {
        async query() { throw new Error('connection reset'); },
        release() { this.gone = true; },
      };
    },
  };
  await assert.rejects(() => acquireWriterLock(pool, log), /connection reset/);
});
