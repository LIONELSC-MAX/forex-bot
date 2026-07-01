import express from "express";
import cors from "cors";
import webpush from "web-push";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import { analyzeTechnical } from "./technical-analyzer.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const SCAN_INTERVAL_MS = (parseInt(process.env.SCAN_INTERVAL_SECONDS) || 300) * 1000;
const WATCHED_PAIRS = (process.env.WATCHED_PAIRS || "XAU/USD").split(",").map((p) => p.trim());
const TIMEFRAME = process.env.TIMEFRAME || "1h";

const requiredEnv = ["TWELVEDATA_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("ERROR: environment variable belum diisi:", missing.join(", "));
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const DB_FILE = "./db.json";
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { subscriptions: [], lastResults: {}, history: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf-8")); }
  catch { return { subscriptions: [], lastResults: {}, history: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// === Ambil harga realtime (terpisah dari candle) ===
async function fetchRealtimePrice(pair) {
  // Untuk XAU/USD gunakan simbol khusus
  const symbol = pair === "XAU/USD" ? "XAU/USD" : pair;
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVEDATA_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.price) return parseFloat(data.price);
  return null;
}

// === Ambil data candle dari Twelve Data ===
async function fetchCandles(pair, timeframe) {
  // Map timeframe dengan benar
  const intervalMap = { "1min": "1min", "5min": "5min", "15min": "15min", "1h": "1h", "4h": "4h", "1day": "1day" };
  const interval = intervalMap[timeframe] || "1h";
  
  // Untuk XAU/USD, Twelve Data pakai simbol XAU/USD
  const symbol = pair;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=250&apikey=${TWELVEDATA_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status === "error" || !data.values) {
    throw new Error(`Twelve Data error untuk ${pair}: ${data.message || "unknown error"}`);
  }

  return data.values.reverse().map((v) => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

// === Push notification ===
async function sendPushToAll(payload) {
  const payloadStr = JSON.stringify(payload);
  const results = await Promise.allSettled(
    db.subscriptions.map((sub) => webpush.sendNotification(sub, payloadStr)),
  );
  const stillValid = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") stillValid.push(db.subscriptions[i]);
    else if (r.reason?.statusCode !== 410 && r.reason?.statusCode !== 404) stillValid.push(db.subscriptions[i]);
  });
  db.subscriptions = stillValid;
  saveDB(db);
}

// === Scan utama ===
async function runScan() {
  console.log(`[${new Date().toISOString()}] Memulai scan ${WATCHED_PAIRS.length} pair...`);

  for (const pair of WATCHED_PAIRS) {
    try {
      const candles = await fetchCandles(pair, TIMEFRAME);
      
      // Ambil harga realtime terpisah untuk akurasi
      const realtimePrice = await fetchRealtimePrice(pair);
      
      const result = analyzeTechnical(candles, pair, TIMEFRAME);
      
      // Gunakan harga realtime jika tersedia, fallback ke candle terakhir
      const lastClose = realtimePrice || candles[candles.length - 1].close;
      const prevClose = candles[candles.length - 2]?.close || lastClose;

      const entry = {
        pair,
        timeframe: TIMEFRAME,
        price: lastClose,
        prev_price: prevClose,
        result,
        timestamp: new Date().toISOString(),
      };

      db.lastResults[pair] = entry;
      db.history.unshift(entry);
      db.history = db.history.slice(0, 100);
      saveDB(db);

      console.log(`  ${pair}: ${result.signal} (${result.strength}) @ ${lastClose}`);

      if (result.signal !== "NEUTRAL") {
        await sendPushToAll({
          title: `Sinyal ${result.signal} — ${pair}`,
          body: result.summary,
          pair,
          signal: result.signal,
          strength: result.strength,
          entry: result.entry,
          sl: result.sl,
          tp: result.tp,
        });
      }

      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.error(`  Gagal analisis ${pair}:`, err.message);
    }
  }

  console.log(`[${new Date().toISOString()}] Scan selesai.\n`);
}

// === API Endpoints ===
app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "Subscription tidak valid" });
  const exists = db.subscriptions.find((s) => s.endpoint === subscription.endpoint);
  if (!exists) { db.subscriptions.push(subscription); saveDB(db); }
  res.status(201).json({ message: "Subscribed" });
});

app.post("/api/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== endpoint);
  saveDB(db);
  res.json({ message: "Unsubscribed" });
});

app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// === Endpoint /api/signal — untuk frontend baru ===
app.get("/api/signal", (req, res) => {
  const pair = req.query.pair || WATCHED_PAIRS[0];
  const data = db.lastResults[pair];
  if (!data) return res.status(404).json({ error: "Belum ada data scan" });

  const r = data.result;
  res.json({
    signal: r.signal,
    confidence: r.strength === "STRONG" ? 85 : r.strength === "MODERATE" ? 70 : 55,
    price: data.price,
    prev_price: data.prev_price || data.price,
    sl: r.sl,
    tp: r.tp,
    indicators: {
      rsi:      { value: r.indicators.rsi,        label: "RSI 14" },
      macd:     { value: r.indicators.macd,       label: "MACD",    signal: parseFloat(r.indicators.macd) > 0 ? "bull" : "bear" },
      bb_width: { value: r.indicators.bbUpper && r.indicators.bbLower ? ((parseFloat(r.indicators.bbUpper) - parseFloat(r.indicators.bbLower)) / parseFloat(r.indicators.bbMiddle)).toFixed(4) : null, label: "BB Width" },
      ema50:    { value: r.indicators.ema50,      label: "EMA 50" },
      ema200:   { value: r.indicators.ema200,     label: "EMA 200" },
      stoch_k:  { value: r.indicators.stochastic, label: "Stoch %K" },
      atr:      { value: r.indicators.atr,        label: "ATR 14" },
    },
    history: db.history.slice(0, 10).map(h => ({
      time: h.timestamp,
      signal: h.result.signal,
      entry: h.price,
      sl: h.result.sl,
      tp: h.result.tp,
      outcome: "pending",
    })),
  });
});

app.get("/api/results", (req, res) => {
  res.json({ results: db.lastResults, pairs: WATCHED_PAIRS, timeframe: TIMEFRAME, scanIntervalSeconds: SCAN_INTERVAL_MS / 1000 });
});

app.get("/api/history", (req, res) => {
  res.json({ history: db.history.slice(0, 50) });
});

app.post("/api/scan-now", async (req, res) => {
  res.json({ message: "Scan dimulai" });
  runScan().catch((err) => console.error("Scan manual gagal:", err.message));
});

app.get("/api/status", (req, res) => {
  res.json({ status: "running", watchedPairs: WATCHED_PAIRS, timeframe: TIMEFRAME, scanIntervalSeconds: SCAN_INTERVAL_MS / 1000, subscriberCount: db.subscriptions.length });
});

app.get("/api/candles/:pair", async (req, res) => {
  try {
    const pair = decodeURIComponent(req.params.pair);
    const tf = req.query.timeframe || TIMEFRAME;
    const candles = await fetchCandles(pair, tf);
    res.json({ candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// === Auto scan ===
let scanTimer = null;
function startAutoScan() {
  if (scanTimer) clearInterval(scanTimer);
  runScan().catch((err) => console.error("Scan awal gagal:", err.message));
  scanTimer = setInterval(() => {
    runScan().catch((err) => console.error("Scan terjadwal gagal:", err.message));
  }, SCAN_INTERVAL_MS);
  console.log(`Auto-scan aktif, interval setiap ${SCAN_INTERVAL_MS / 1000} detik`);
}

app.listen(PORT, () => {
  console.log(`Forex AI Monitor backend jalan di port ${PORT}`);
  console.log(`Pair yang dipantau: ${WATCHED_PAIRS.join(", ")}`);
  startAutoScan();
});
