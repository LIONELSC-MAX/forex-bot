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
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const SCAN_INTERVAL_MS = (parseInt(process.env.SCAN_INTERVAL_SECONDS) || 300) * 1000;
const WATCHED_PAIRS = (process.env.WATCHED_PAIRS || 'EUR/USD,GBP/USD,USD/JPY').split(',').map(p => p.trim());
const TIMEFRAME = process.env.TIMEFRAME || '4h';

const requiredEnv = ['TWELVEDATA_API_KEY', 'FINNHUB_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('ERROR: environment variable belum diisi:', missing.join(', '));
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const DB_FILE = './db.json';
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { subscriptions: [], lastResults: {}, history: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch { return { subscriptions: [], lastResults: {}, history: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// === Cache harga real-time dari Finnhub WebSocket ===
const realtimePrice = {};

function toFinnhubSymbol(pair) {
  return 'OANDA:' + pair.replace('/', '_');
}

// === Finnhub WebSocket: harga real-time ===
let finnhubWs = null;
function connectFinnhubWebSocket() {
  if (finnhubWs) { try { finnhubWs.terminate(); } catch {} }

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
          for (const pair of WATCHED_PAIRS) {
            if (trade.s === toFinnhubSymbol(pair)) {
              realtimePrice[pair] = { price: trade.p, timestamp: new Date(trade.t).toISOString() };
            }
          }
        }
      }
    } catch (err) { console.error('[Finnhub WS] Parse error:', err.message); }
  });

  finnhubWs.on('error', (err) => console.error('[Finnhub WS] Error:', err.message));
  finnhubWs.on('close', () => {
    console.log('[Finnhub WS] Putus, reconnect 5 detik...');
    setTimeout(connectFinnhubWebSocket, 5000);
  });
}

// === TwelveData: ambil candle historis ===
async function fetchCandles(pair, timeframe) {
  const interval = timeframe === '1h' ? '1h' : timeframe === '1day' ? '1day' : '4h';
  const symbol = pair.replace('/', '/');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=20&apikey=${TWELVEDATA_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status === 'error' || !data.values) {
    throw new Error(`TwelveData error untuk ${pair}: ${data.message || 'unknown'}`);
  }

  let candles = data.values.reverse().map(v => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close)
  }));

  // Timpa close terakhir dengan harga real-time Finnhub kalau ada
  const rt = realtimePrice[pair];
  if (rt && candles.length > 0) {
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = {
      ...last,
      close: rt.price,
      high: Math.max(last.high, rt.price),
      low: Math.min(last.low, rt.price)
    };
    console.log(`  [RT Finnhub] ${pair}: ${rt.price}`);
  }

  return candles;
}

// === Endpoints ===
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Subscription tidak valid' });
  const exists = db.subscriptions.find(s => s.endpoint === subscription.endpoint);
  if (!exists) { db.subscriptions.push(subscription); saveDB(db); }
  res.status(201).json({ message: 'Subscribed' });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  db.subscriptions = db.subscriptions.filter(s => s.endpoint !== endpoint);
  saveDB(db);
  res.json({ message: 'Unsubscribed' });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.get('/api/results', (req, res) => {
  res.json({
    results: db.lastResults,
    pairs: WATCHED_PAIRS,
    timeframe: TIMEFRAME,
    scanIntervalSeconds: SCAN_INTERVAL_MS / 1000,
    realtimePrices: realtimePrice
  });
});

app.get('/api/history', (req, res) => {
  res.json({ history: db.history.slice(0, 50) });
});

app.get('/api/prices', (req, res) => {
  res.json({ prices: realtimePrice });
});

app.post('/api/scan-now', async (req, res) => {
  res.json({ message: 'Scan dimulai' });
  runScan().catch(err => console.error('Scan manual gagal:', err.message));
});

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

// === Push notification ===
async function sendPushToAll(payload) {
  const payloadStr = JSON.stringify(payload);
  const results = await Promise.allSettled(
    db.subscriptions.map(sub => webpush.sendNotification(sub, payloadStr))
  );
  const stillValid = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') stillValid.push(db.subscriptions[i]);
    else if (r.reason?.statusCode !== 410 && r.reason?.statusCode !== 404) stillValid.push(db.subscriptions[i]);
  });
  db.subscriptions = stillValid;
  saveDB(db);
}

// === Scan utama ===
async function runScan() {
  console.log(`[${new Date().toISOString()}] Scan ${WATCHED_PAIRS.length} pair...`);
  for (const pair of WATCHED_PAIRS) {
    try {
      const candles = await fetchCandles(pair, TIMEFRAME);
      const result = analyzeTechnical(candles, pair, TIMEFRAME);
      const lastClose = candles[candles.length - 1].close;

      const entry = {
        pair, timeframe: TIMEFRAME, price: lastClose,
        isRealtime: !!realtimePrice[pair],
        result, timestamp: new Date().toISOString()
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
          pair, signal: result.signal, strength: result.strength,
          entry: result.entry, sl: result.sl, tp: result.tp
        });
      }

      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error(`  Gagal ${pair}:`, err.message);
    }
  }
  console.log(`[${new Date().toISOString()}] Scan selesai.\n`);
}

let scanTimer = null;
function startAutoScan() {
  if (scanTimer) clearInterval(scanTimer);
  runScan().catch(err => console.error('Scan awal gagal:', err.message));
  scanTimer = setInterval(() => {
    runScan().catch(err => console.error('Scan terjadwal gagal:', err.message));
  }, SCAN_INTERVAL_MS);
  console.log(`Auto-scan aktif, interval ${SCAN_INTERVAL_MS / 1000} detik`);
}

app.listen(PORT, () => {
  console.log(`Forex Monitor backend jalan di port ${PORT}`);
  console.log(`Pair: ${WATCHED_PAIRS.join(', ')}`);
  connectFinnhubWebSocket();
  startAutoScan();
});
