import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';
import { analyzeTechnical } from './technical-analyzer.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const SCAN_INTERVAL_MS = (parseInt(process.env.SCAN_INTERVAL_SECONDS) || 300) * 1000;
const WATCHED_PAIRS = (process.env.WATCHED_PAIRS || 'EUR/USD,GBP/USD,USD/JPY').split(',').map(p => p.trim());
const TIMEFRAME = process.env.TIMEFRAME || '4h';

// validasi env wajib - tidak ada lagi ANTHROPIC_API_KEY karena analisis 100% berbasis rumus, gratis
const requiredEnv = ['TWELVEDATA_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('ERROR: environment variable belum diisi:', missing.join(', '));
  console.error('Salin .env.example ke .env lalu isi semua value-nya.');
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// === Penyimpanan sederhana berbasis file JSON (cocok untuk single-user / small scale) ===
const DB_FILE = './db.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { subscriptions: [], lastResults: {}, history: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return { subscriptions: [], lastResults: {}, history: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// === Endpoint: simpan push subscription dari browser ===
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Subscription tidak valid' });
  }
  const exists = db.subscriptions.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    db.subscriptions.push(subscription);
    saveDB(db);
  }
  res.status(201).json({ message: 'Subscribed' });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  db.subscriptions = db.subscriptions.filter(s => s.endpoint !== endpoint);
  saveDB(db);
  res.json({ message: 'Unsubscribed' });
});

// === Endpoint: ambil VAPID public key (dibutuhkan frontend) ===
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// === Endpoint: lihat hasil analisis terakhir semua pair ===
app.get('/api/results', (req, res) => {
  res.json({
    results: db.lastResults,
    pairs: WATCHED_PAIRS,
    timeframe: TIMEFRAME,
    scanIntervalSeconds: SCAN_INTERVAL_MS / 1000
  });
});

// === Endpoint: lihat riwayat sinyal ===
app.get('/api/history', (req, res) => {
  res.json({ history: db.history.slice(0, 50) });
});

// === Endpoint: trigger scan manual ===
app.post('/api/scan-now', async (req, res) => {
  res.json({ message: 'Scan dimulai, hasil akan tersedia beberapa saat lagi' });
  runScan().catch(err => console.error('Scan manual gagal:', err.message));
});

// === Ambil data candle dari Twelve Data ===
async function fetchCandles(pair, timeframe) {
  const interval = timeframe === '1h' ? '1h' : timeframe === '1day' ? '1day' : '4h';
  const symbol = pair.replace('/', '/');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=20&apikey=${TWELVEDATA_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status === 'error' || !data.values) {
    throw new Error(`Twelve Data error untuk ${pair}: ${data.message || 'unknown error'}`);
  }

  // data.values urutannya dari terbaru ke terlama, kita balik jadi kronologis
  return data.values.reverse().map(v => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close)
  }));
}

// Analisis sinyal sekarang dihitung lokal oleh modul technical-analyzer.js
// (moving average crossover, RSI, deteksi breakout) - tidak ada panggilan API berbayar.

// === Kirim push notification ke semua subscriber ===
async function sendPushToAll(payload) {
  const payloadStr = JSON.stringify(payload);
  const results = await Promise.allSettled(
    db.subscriptions.map(sub => webpush.sendNotification(sub, payloadStr))
  );

  // hapus subscription yang sudah tidak valid (410 Gone / 404)
  const stillValid = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      stillValid.push(db.subscriptions[i]);
    } else if (r.reason?.statusCode !== 410 && r.reason?.statusCode !== 404) {
      stillValid.push(db.subscriptions[i]);
    }
  });
  db.subscriptions = stillValid;
  saveDB(db);
}

// === Proses scan utama: jalan tiap interval ===
async function runScan() {
  console.log(`[${new Date().toISOString()}] Memulai scan ${WATCHED_PAIRS.length} pair...`);

  for (const pair of WATCHED_PAIRS) {
    try {
      const candles = await fetchCandles(pair, TIMEFRAME);
      const result = analyzeTechnical(candles, pair, TIMEFRAME);
      const lastClose = candles[candles.length - 1].close;

      const entry = {
        pair,
        timeframe: TIMEFRAME,
        price: lastClose,
        result,
        timestamp: new Date().toISOString()
      };

      db.lastResults[pair] = entry;
      db.history.unshift(entry);
      db.history = db.history.slice(0, 100);
      saveDB(db);

      console.log(`  ${pair}: ${result.signal} (${result.strength})`);

      // hanya kirim notifikasi push kalau sinyal bukan NEUTRAL
      if (result.signal !== 'NEUTRAL') {
        await sendPushToAll({
          title: `Sinyal ${result.signal} — ${pair}`,
          body: result.summary,
          pair,
          signal: result.signal,
          strength: result.strength,
          entry: result.entry,
          sl: result.sl,
          tp: result.tp
        });
      }

      // jeda kecil antar pair supaya tidak membanjiri Twelve Data sekaligus
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error(`  Gagal analisis ${pair}:`, err.message);
    }
  }

  console.log(`[${new Date().toISOString()}] Scan selesai.\n`);
}

// === Jalankan scan otomatis berkala ===
let scanTimer = null;
function startAutoScan() {
  if (scanTimer) clearInterval(scanTimer);
  runScan().catch(err => console.error('Scan awal gagal:', err.message));
  scanTimer = setInterval(() => {
    runScan().catch(err => console.error('Scan terjadwal gagal:', err.message));
  }, SCAN_INTERVAL_MS);
  console.log(`Auto-scan aktif, interval setiap ${SCAN_INTERVAL_MS / 1000} detik`);
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    watchedPairs: WATCHED_PAIRS,
    timeframe: TIMEFRAME,
    scanIntervalSeconds: SCAN_INTERVAL_MS / 1000,
    subscriberCount: db.subscriptions.length
  });
});

app.listen(PORT, () => {
  console.log(`Forex AI Monitor backend jalan di port ${PORT}`);
  console.log(`Pair yang dipantau: ${WATCHED_PAIRS.join(', ')}`);
  startAutoScan();
});
