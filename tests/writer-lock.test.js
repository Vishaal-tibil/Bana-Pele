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
