// CLEARANCE - Ren'Py Web Build Server
const express = require("express");
const compression = require("compression");
const path = require("path");
let MongoClient = null;
try { ({ MongoClient } = require('mongodb')); } catch (e) { /* optional */ }

// ============================================
// Configuration
// ============================================
const app = express();
const base = "/webhook3";
const root = path.join(__dirname, "web");
const port = 9089;
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const mongoDbName = process.env.MONGODB_DB || 'clearance_study';
const mongoCollSessions = 'sessions';

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';
const inMemoryStore = { sessions: new Map() };
let mongoClient = null;

// ============================================
// MongoDB Connection
// ============================================
async function getMongo() {
  if (LOCAL_MODE) return null;
  if (!MongoClient) throw new Error('mongodb driver not installed. Run: npm install mongodb');
  if (mongoClient && mongoClient.topology?.isConnected()) return mongoClient;
  mongoClient = new MongoClient(mongoUri, { ignoreUndefined: true });
  await mongoClient.connect();
  console.log('[MongoDB] Connected to', mongoDbName);
  return mongoClient;
}

// ============================================
// Express Setup
// ============================================
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(compression());
app.use(`${base}/api/`, express.json({ limit: "5mb" }));

// Serve .wasm with correct MIME type (required by Ren'Py web)
express.static.mime.define({ 'application/wasm': ['wasm'] });

// Static files — serve the Ren'Py web build
app.use(base, express.static(root, { extensions: ["html"] }));

// ============================================
// API: Store Session Data (called from Ren'Py via JavaScript)
// ============================================
app.post(`${base}/api/store-session`, async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.participantId) {
      return res.status(400).json({ error: 'missing_participantId' });
    }

    const participantId = payload.participantId;
    const now = new Date().toISOString();

    if (!payload.createdAt) payload.createdAt = now;
    payload.updatedAt = now;
    payload.serverReceivedAt = now;
    payload.remote = { ip: req.ip };

    if (LOCAL_MODE) {
      const existing = inMemoryStore.sessions.get(participantId);
      if (existing) {
        Object.assign(existing, payload);
      } else {
        inMemoryStore.sessions.set(participantId, { ...payload, createdAt: now });
      }
      console.log(`[LOCAL] Saved session ${participantId}, total: ${inMemoryStore.sessions.size}`);
      return res.json({ ok: true, participantId, local: true });
    }

    const client = await getMongo();
    const db = client.db(mongoDbName);
    const coll = db.collection(mongoCollSessions);

    const { createdAt, ...updateFields } = payload;
    const result = await coll.updateOne(
      { participantId },
      { $set: updateFields, $setOnInsert: { createdAt: createdAt || now } },
      { upsert: true }
    );

    console.log(`[store-session] participantId: ${participantId}, upserted: ${result.upsertedCount}`);
    return res.json({ ok: true, participantId });
  } catch (err) {
    console.error('store-session error:', err);
    return res.status(500).json({ error: 'store_failed' });
  }
});

// ============================================
// API: Stats
// ============================================
app.get(`${base}/api/stats`, async (req, res) => {
  try {
    if (LOCAL_MODE) {
      const sessions = Array.from(inMemoryStore.sessions.values());
      return res.json({ local: true, totalSessions: sessions.length });
    }

    const client = await getMongo();
    const db = client.db(mongoDbName);
    const coll = db.collection(mongoCollSessions);
    const totalSessions = await coll.countDocuments();
    return res.json({ totalSessions });
  } catch (err) {
    console.error('stats error:', err);
    return res.status(500).json({ error: 'stats_failed' });
  }
});

// ============================================
// API: Export
// ============================================
app.get(`${base}/api/export`, async (req, res) => {
  try {
    let sessions;
    if (LOCAL_MODE) {
      sessions = Array.from(inMemoryStore.sessions.values());
    } else {
      const client = await getMongo();
      const db = client.db(mongoDbName);
      sessions = await db.collection(mongoCollSessions).find({}).toArray();
    }
    return res.json({ exportDate: new Date().toISOString(), totalParticipants: sessions.length, data: sessions });
  } catch (err) {
    console.error('export error:', err);
    return res.status(500).json({ error: 'export_failed' });
  }
});

// ============================================
// SPA Fallback
// ============================================
app.use(base, (_req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

// ============================================
// Start Server
// ============================================
app.listen(port, "127.0.0.1", () => {
  console.log(`\n========================================`);
  console.log(`CLEARANCE Study Server (Ren'Py Web)`);
  console.log(`========================================`);
  console.log(`URL: http://127.0.0.1:${port}${base}`);
  console.log(`Mode: ${LOCAL_MODE ? 'LOCAL (in-memory)' : 'Production (MongoDB)'}`);
  console.log(`========================================\n`);
});
