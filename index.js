// Safwah API — thin backend so the mobile app never holds the Mongo credential.
// Connects to MongoDB Atlas; if unreachable (e.g. IP not allowlisted) it falls back
// to an in-memory store so the app demo still works.
import express from 'express';
import cors from 'cors';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 4000;
const URI = process.env.MONGODB_URI;

// AED is pegged ~3.6725 to the USD; USDT ≈ USD.
const RATES = { aedPerUsd: 3.6725, usdtPerUsd: 1.0 };

const SEED_TX = [
  { merchant: 'Dubai Mall — Apple', category: 'Electronics', amountAED: 1250.0, vatAED: 62.5, token: 'USDT', status: 'completed', ts: Date.now() - 1000 * 60 * 30 },
  { merchant: 'Salt Bae Steakhouse', category: 'Dining', amountAED: 480.0, vatAED: 24.0, token: 'USDT', status: 'completed', ts: Date.now() - 1000 * 60 * 90 },
  { merchant: 'Emirates Spinneys', category: 'Groceries', amountAED: 212.4, vatAED: 10.62, token: 'AED', status: 'completed', ts: Date.now() - 1000 * 60 * 60 * 26 },
  { merchant: 'Careem Ride', category: 'Transport', amountAED: 38.0, vatAED: 1.9, token: 'AED', status: 'completed', ts: Date.now() - 1000 * 60 * 60 * 27 },
  { merchant: 'Gold Souk Jewellery', category: 'Retail', amountAED: 3400.0, vatAED: 170.0, token: 'USDT', status: 'completed', ts: Date.now() - 1000 * 60 * 60 * 80 },
];

const DEFAULT_PROFILE = (address) => ({
  address,
  name: 'Aisha Rahman',
  country: 'United Kingdom',
  passport: 'GBR••••2841',
  tier: 'Gold',
  sfl: 1284,
  sflToNext: 716,
  memberSince: '2026',
});

// --- storage: Mongo if available, else in-memory ---
let mongo = null;
const mem = { transactions: [...SEED_TX], profiles: {} };

const store = {
  async listTx() {
    if (mongo) return mongo.collection('transactions').find({}).sort({ ts: -1 }).limit(50).toArray();
    return [...mem.transactions].sort((a, b) => b.ts - a.ts).slice(0, 50);
  },
  async addTx(tx) {
    const doc = { ...tx, ts: tx.ts || Date.now(), status: tx.status || 'completed' };
    if (mongo) await mongo.collection('transactions').insertOne(doc);
    else mem.transactions.push(doc);
    return doc;
  },
  async getProfile(address) {
    const a = String(address).toLowerCase();
    if (mongo) return (await mongo.collection('profiles').findOne({ address: a })) || DEFAULT_PROFILE(a);
    return mem.profiles[a] || DEFAULT_PROFILE(a);
  },
  async putProfile(address, patch) {
    const a = String(address).toLowerCase();
    const next = { ...(await this.getProfile(a)), ...patch, address: a };
    if (mongo) await mongo.collection('profiles').updateOne({ address: a }, { $set: next }, { upsert: true });
    else mem.profiles[a] = next;
    return next;
  },
  // Spending analytics over completed transactions — backs the "VAT reclaimable"
  // tile and the category spending breakdown in the tourist app.
  async stats() {
    const rows = mongo
      ? await mongo.collection('transactions').find({}).toArray()
      : [...mem.transactions];
    const round2 = (n) => Math.round(n * 100) / 100;
    const byCategory = {};
    const byToken = {};
    let totalSpentAED = 0;
    let totalVatAED = 0;
    let txCount = 0;

    for (const t of rows) {
      if ((t.status || 'completed') !== 'completed') continue; // only settled spend counts
      const amt = Number(t.amountAED) || 0;
      const vat = Number(t.vatAED) || 0;
      totalSpentAED += amt;
      totalVatAED += vat;
      txCount += 1;

      const cat = t.category || 'Other';
      byCategory[cat] = byCategory[cat] || { count: 0, amountAED: 0 };
      byCategory[cat].count += 1;
      byCategory[cat].amountAED = round2(byCategory[cat].amountAED + amt);

      const tok = t.token || 'AED';
      byToken[tok] = round2((byToken[tok] || 0) + amt);
    }

    return {
      txCount,
      totalSpentAED: round2(totalSpentAED),
      totalVatAED: round2(totalVatAED),
      byCategory,
      byToken,
    };
  },
};

async function connectMongo() {
  if (!URI) return;
  try {
    const client = new MongoClient(URI, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      serverSelectionTimeoutMS: 6000,
    });
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    mongo = client.db('safwah');
    if ((await mongo.collection('transactions').countDocuments()) === 0) {
      await mongo.collection('transactions').insertMany(SEED_TX);
    }
    console.log('[api] connected to MongoDB Atlas (db: safwah)');
  } catch (err) {
    console.warn('[api] MongoDB unreachable, using in-memory store:', err.message);
  }
}

export const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, store: mongo ? 'mongodb' : 'memory' }));
app.get('/rates', (_req, res) => res.json({ ...RATES, updatedAt: Date.now() }));
app.get('/transactions', async (_req, res) => res.json(await store.listTx()));
app.post('/transactions', async (req, res) => res.json(await store.addTx(req.body || {})));
app.get('/stats', async (_req, res) => res.json({ ...(await store.stats()), updatedAt: Date.now() }));
app.get('/profile/:address', async (req, res) => res.json(await store.getProfile(req.params.address)));
app.put('/profile/:address', async (req, res) => res.json(await store.putProfile(req.params.address, req.body || {})));

// Exposed for tests: the store, the peg rates, the default profile shape, and a
// helper to reset the in-memory store between test cases.
export { store, RATES, DEFAULT_PROFILE };
export function resetMemory() {
  mem.transactions = [...SEED_TX];
  for (const key of Object.keys(mem.profiles)) delete mem.profiles[key];
}

// Start the server only when run directly (`node index.js`), not when a test
// imports this module — so tests never open a port or reach out to MongoDB.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  connectMongo().finally(() => {
    app.listen(PORT, () => console.log(`[api] Safwah API on http://localhost:${PORT} (store: ${mongo ? 'mongodb' : 'memory'})`));
  });
}
