// Integration tests for the Safwah API — drives the real Express app over HTTP on
// an ephemeral port using Node's built-in test runner + fetch (no DB, no extra deps).
// The app falls back to its in-memory store when Mongo isn't connected, so these
// exercise the full request→route→store→response path deterministically.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { app, RATES, resetMemory, store } from '../index.js';

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => server.close(resolve)));

// Each test starts from the same seeded store.
beforeEach(() => resetMemory());

const get = (path) =>
  fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json() }));
const sendJson = (method, path, body) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

// --- health & rates ---------------------------------------------------------

test('GET /health reports ok and the in-memory store', async () => {
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.store, 'memory');
});

test('GET /rates returns the AED/USDT peg with a timestamp', async () => {
  const { status, body } = await get('/rates');
  assert.equal(status, 200);
  assert.equal(body.aedPerUsd, RATES.aedPerUsd);
  assert.equal(body.aedPerUsd, 3.6725);
  assert.equal(body.usdtPerUsd, 1);
  assert.equal(typeof body.updatedAt, 'number');
});

// --- transactions -----------------------------------------------------------

test('GET /transactions returns the seed data, newest-first', async () => {
  const { status, body } = await get('/transactions');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 5);
  for (let i = 1; i < body.length; i++) {
    assert.ok(body[i - 1].ts >= body[i].ts, 'transactions must be sorted by ts desc');
  }
  // The most recent seed row (ts = now - 30m) is the Apple purchase.
  assert.equal(body[0].merchant, 'Dubai Mall — Apple');
});

test('POST /transactions applies status/ts defaults and lands newest-first', async () => {
  const { status, body } = await sendJson('POST', '/transactions', {
    merchant: 'Test Cafe',
    category: 'Dining',
    amountAED: 42.5,
    token: 'USDT',
  });
  assert.equal(status, 200);
  assert.equal(body.merchant, 'Test Cafe');
  assert.equal(body.status, 'completed'); // defaulted
  assert.equal(typeof body.ts, 'number'); // defaulted

  const list = (await get('/transactions')).body;
  assert.equal(list.length, 6);
  assert.equal(list[0].merchant, 'Test Cafe'); // newest sits on top
});

test('POST /transactions preserves an explicitly supplied status and ts', async () => {
  const { body } = await sendJson('POST', '/transactions', {
    merchant: 'Pending Co',
    amountAED: 5,
    status: 'pending',
    ts: 123,
  });
  assert.equal(body.status, 'pending');
  assert.equal(body.ts, 123);
});

// --- profiles ---------------------------------------------------------------

test('GET /profile/:address returns the default profile with a lowercased address', async () => {
  const { status, body } = await get('/profile/0xABCDEF');
  assert.equal(status, 200);
  assert.equal(body.address, '0xabcdef');
  assert.equal(body.name, 'Aisha Rahman');
  assert.equal(body.tier, 'Gold');
  assert.equal(body.sfl, 1284);
});

test('PUT /profile/:address merges a patch, keeps other defaults, and persists', async () => {
  const put = await sendJson('PUT', '/profile/0xAbC123', { name: 'Sara', tier: 'Platinum' });
  assert.equal(put.body.name, 'Sara');
  assert.equal(put.body.tier, 'Platinum');
  assert.equal(put.body.address, '0xabc123'); // lowercased
  assert.equal(put.body.sfl, 1284); // untouched default preserved

  const again = await get('/profile/0xabc123');
  assert.equal(again.body.name, 'Sara');
  assert.equal(again.body.tier, 'Platinum');
});

test('profile lookups are case-insensitive across writes and reads', async () => {
  await sendJson('PUT', '/profile/0xDEADBEEF', { name: 'CaseCheck' });
  const lower = await get('/profile/0xdeadbeef');
  assert.equal(lower.body.name, 'CaseCheck');
});

// --- stats (analytics) ------------------------------------------------------

test('GET /stats aggregates the seed spend correctly', async () => {
  const { status, body } = await get('/stats');
  assert.equal(status, 200);
  assert.equal(body.txCount, 5);
  assert.equal(body.totalSpentAED, 5380.4); // 1250+480+212.4+38+3400
  assert.equal(body.totalVatAED, 269.02); // 62.5+24+10.62+1.9+170
  assert.equal(typeof body.updatedAt, 'number');
});

test('GET /stats breaks spend down by token and category', async () => {
  const { body } = await get('/stats');
  assert.equal(body.byToken.USDT, 5130); // 1250+480+3400
  assert.equal(body.byToken.AED, 250.4); // 212.4+38
  assert.equal(body.byCategory.Electronics.amountAED, 1250);
  assert.equal(body.byCategory.Electronics.count, 1);
  assert.equal(body.byCategory.Retail.amountAED, 3400);
});

test('GET /stats reflects a newly posted transaction', async () => {
  await sendJson('POST', '/transactions', {
    merchant: 'New Spot',
    category: 'Dining',
    amountAED: 100,
    vatAED: 5,
    token: 'AED',
  });
  const { body } = await get('/stats');
  assert.equal(body.txCount, 6);
  assert.equal(body.totalSpentAED, 5480.4);
  assert.equal(body.totalVatAED, 274.02);
  assert.equal(body.byCategory.Dining.count, 2); // Salt Bae + New Spot
});

test('GET /stats excludes non-completed (e.g. pending) transactions', async () => {
  await sendJson('POST', '/transactions', {
    merchant: 'Held',
    category: 'Retail',
    amountAED: 999,
    vatAED: 49.95,
    status: 'pending',
  });
  const { body } = await get('/stats');
  assert.equal(body.txCount, 5); // pending row not counted
  assert.equal(body.totalSpentAED, 5380.4); // unchanged
});

// --- store unit-level checks (no HTTP) --------------------------------------

test('store.addTx then store.listTx round-trips through the in-memory store', async () => {
  resetMemory();
  await store.addTx({ merchant: 'Direct', amountAED: 1, token: 'AED' });
  const rows = await store.listTx();
  assert.equal(rows.length, 6);
  assert.equal(rows[0].merchant, 'Direct');
});
