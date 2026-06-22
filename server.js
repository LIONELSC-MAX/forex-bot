import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';
import WebSocket from 'ws';
import { analyzeTechnical } from './technical-analyzer.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const SCAN_INTERVAL_MS = (parseInt(process.env.SCAN_INTERVAL_SECONDS) || 300) * 1000;
const WATCHED_PAIRS = (process.env.WATCHED_PAIRS || 'EUR/USD,GBP/USD,USD/JPY').split(',').map(p => p.trim());
const TIMEFRAME = process.env.TIMEFRAME || '4h';

// validasi env wajib
const requiredEnv = ['FINNHUB_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
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

// === Penyimpanan sederhana berbasis file JSON ===
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

// === Cache harga real-time dari Finnhub WebSocket ===
// key: "EUR/USD", value: { price, timestamp }
const realtimePrice = {};

// === Konversi pair ke format Finnhub (OANDA:EUR_USD) ===
function toFinnhubSymbol(pair) {
  return 'OANDA:' + pair.replace('/', '_');
}

// === Finnhub WebSocket: subscribe harga real-time semua pair ===
let finnhubWs = null;

function connectFinnhubWebSocket() {
  if (finnhubWs) {
    try { finnhubWs.terminate(); } catch {}
  }

  finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);

  finnhubWs.on('open', () => {
    console.log('[Finnhub WS] Terhubung, subscribe pair...');
    for (const pair of WATCHED_PAIRS) {
      const symbol = toFinnhubSymbol(pair);
      finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol }));
      console.log(`  Subscribe: ${symbol}`);
    }
  });

  finnhubWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'trade' && msg.data) {
        for (const trade of msg.data) {
          // cari pair yang cocok dari symbol
          for (const pair of WATCHED_PAIRS) {
            if (trade.s === toFinnhubSymbol(pair)) {
              realtimePrice[pair] = {
                price: trade.p,
                timestamp: new Date(trade.t).toISOString()
              };
            }
          }
        }
      }
    } catch (err) {
      console.error('[Finnhub WS] Parse error:', err.message);
    }
  });

  finnhubWs.on('error', (err) => {
    console.error('[Finnhub WS] Error:', err.message);
  });

  finnhubWs.on('close', () => {
    console.log('[Finnhub WS] Koneksi putus, reconnect 5 detik lagi...');
    setTimeout(connectFinnhubWebSocket, 5000);
  });
}

// === Ambil candle historis dari Finnhub REST (untuk analisis teknikal) ===
// Digunakan saat scan: ambil 20 candle terakhir, lalu timpa harga close terakhir
// dengan harga real-time dari WebSocket (kalau tersedia)
function timeframeToFinnhubResolution(tf) {
  const map = { '1h': '60', '4h': '240', '1day': 'D', '1d': 'D' };
  return map[tf] || '240';
}

async function fetchCandles(pair, timeframe) {
  const symbol = toFinnhubSymbol(pair);
  const resolution = timeframeToFinnhubResolution(timeframe);

  // hitung from/to: 20 candle terakhir
  const candleCount = 25; // ambil lebih buat jaga-jaga
  const secondsPerCandle = { '60': 3600, '240': 14400, 'D': 86400 };
  const secs = secondsPerCandle[resolution] || 14400;
  const to = Math.floor(Date.now() / 1000);
  const from = to - secs * candleCount;

  const url = `https://finnhub.io/api/v1/forex/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.s === 'no_data' || !data.c || data.c.length === 0) {
    throw new Error(`Finnhub tidak ada data untuk ${pair}`);
  }

  let candles = data.t.map((time, i) => ({
    time: new Date(time * 1000).toISOString(),
    open: data.o[i],
    high: data.h[i],
    low: data.l[i],
    close: data.c[i]
  }));

  // Timpa close candle terakhir dengan harga real-time WebSocket (kalau ada)
  const rt = realtimePrice[pair];
  if (rt && candles.length > 0) {
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = {
      ...last,
      close: rt.price,
      high: Math.max(last.high, rt.price),
      low: Math.min(last.low, rt.price)
    };
    console.log(`  [RT] ${pair} harga real-time: ${rt.price}`);
  }

  return candles;
}

// === Endpoint: simpan push subscription ===
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

// === Endpoint: ambil VAPID public key ===
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// === Endpoint: hasil analisis terakhir ===
app.get('/api/results', (req, res) => {
  res.json({
    results: db.lastResults,
    pairs: WATCHED_PAIRS,
    timeframe: TIMEFRAME,
    scanIntervalSeconds: SCAN_INTERVAL_MS / 1000,
    realtimePrices: realtimePrice  // bonus: expose harga RT ke frontend
  });
});

// === Endpoint: riwayat sinyal ===
app.get('/api/history', (req, res) => {
  res.json({ history: db.history.slice(0, 50) });
});

// === Endpoint: harga real-time saja (ringan) ===
app.get('/api/prices', (req, res) => {
  res.json({ prices: realtimePrice });
});

// === Endpoint: trigger scan manual ===
app.post('/api/scan-now', async (req, res) => {
  res.json({ message: 'Scan dimulai, hasil akan tersedia beberapa saat lagi' });
  runScan().catch(err => console.error('Scan manual gagal:', err.message));
});

// === Kirim push notification ke semua subscriber ===
async function sendPushToAll(payload) {
  const payloadStr = JSON.stringify(payload);
  const results = await Promise.allSettled(
    db.subscriptions.map(sub => webpush.sendNotification(sub, payloadStr))
  );

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

// === Proses scan utama ===
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
        isRealtime: !!realtimePrice[pair],
        result,
        timestamp: new Date().toISOString()
      };

      db.lastResults[pair] = entry;
      db.history.unshift(entry);
      db.history = db.history.slice(0, 100);
      saveDB(db);

      console.log(`  ${pair}: ${result.signal} (${result.strength}) @ ${lastClose}`);

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

      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error(`  Gagal analisis ${pair}:`, err.message);
    }
  }

  console.log(`[${new Date().toISOString()}] Scan selesai.\n`);
}

// === Auto scan berkala ===
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
    subscriberCount: db.subscriptions.length,
    realtimeConnected: finnhubWs?.readyState === WebSocket.OPEN,
    realtimePairsActive: Object.keys(realtimePrice).length
  });
});

app.listen(PORT, () => {
  console.log(`Forex Monitor backend jalan di port ${PORT}`);
  console.log(`Pair yang dipantau: ${WATCHED_PAIRS.join(', ')}`);
  connectFinnhubWebSocket();  // sambungkan WebSocket real-time
  startAutoScan();
});
