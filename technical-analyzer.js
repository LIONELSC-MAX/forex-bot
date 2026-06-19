// Modul analisis teknikal berbasis rumus matematika klasik.
// Tidak memanggil API berbayar apa pun - seluruh kalkulasi berjalan lokal.

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// === Simple Moving Average ===
function sma(closes, period) {
  if (closes.length < period) return null;
  return average(closes.slice(-period));
}

// === RSI (Relative Strength Index), periode standar 14 ===
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// === Deteksi pola sederhana dari beberapa candle terakhir ===
function detectPattern(candles) {
  const last3 = candles.slice(-3);
  if (last3.length < 3) return 'Data belum cukup';

  const [a, b, c] = last3;
  const aBull = a.close > a.open;
  const bBull = b.close > b.open;
  const cBull = c.close > c.open;

  if (!aBull && !bBull && cBull && c.close > a.open) return 'Reversal bullish (3 candle)';
  if (aBull && bBull && !cBull && c.close < a.open) return 'Reversal bearish (3 candle)';
  if (aBull && bBull && cBull) return 'Tiga candle bullish berurutan';
  if (!aBull && !bBull && !cBull) return 'Tiga candle bearish berurutan';

  const bodyC = Math.abs(c.close - c.open);
  const rangeC = c.high - c.low;
  if (rangeC > 0 && bodyC / rangeC < 0.3) return 'Doji / indecision candle';

  return 'Tidak ada pola dominan';
}

// === Fungsi utama: hitung sinyal trading dari data candle ===
function analyzeTechnical(candles, pair, timeframe) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const lastClose = closes[closes.length - 1];

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, Math.min(20, closes.length));
  const rsiValue = rsi(closes, Math.min(14, closes.length - 1));

  const recentHigh = Math.max(...highs.slice(-10));
  const recentLow = Math.min(...lows.slice(-10));

  // === Logika scoring sederhana: gabungkan beberapa sinyal indikator ===
  let bullScore = 0;
  let bearScore = 0;
  const reasons = [];

  // 1. MA crossover (5 vs 10)
  if (ma5 !== null && ma10 !== null) {
    if (ma5 > ma10) { bullScore += 1; reasons.push('MA5 di atas MA10'); }
    else { bearScore += 1; reasons.push('MA5 di bawah MA10'); }
  }

  // 2. Harga vs MA20 (trend jangka menengah)
  if (ma20 !== null) {
    if (lastClose > ma20) { bullScore += 1; reasons.push('harga di atas MA20'); }
    else { bearScore += 1; reasons.push('harga di bawah MA20'); }
  }

  // 3. RSI overbought/oversold
  let rsiNote = '';
  if (rsiValue !== null) {
    if (rsiValue < 30) { bullScore += 1.5; rsiNote = 'RSI oversold, potensi rebound'; }
    else if (rsiValue > 70) { bearScore += 1.5; rsiNote = 'RSI overbought, potensi koreksi'; }
    else { rsiNote = 'RSI netral'; }
  }

  // 4. Breakout dari range 10 candle terakhir
  let breakoutNote = '';
  if (lastClose >= recentHigh * 0.999) { bullScore += 1; breakoutNote = 'mendekati/breakout resistance'; }
  if (lastClose <= recentLow * 1.001) { bearScore += 1; breakoutNote = 'mendekati/breakdown support'; }

  // === Tentukan sinyal akhir dari scoring ===
  let signal = 'NEUTRAL';
  let strength = 'WEAK';
  const diff = Math.abs(bullScore - bearScore);

  if (bullScore > bearScore && bullScore >= 2) {
    signal = 'BUY';
    strength = diff >= 3 ? 'STRONG' : diff >= 1.5 ? 'MODERATE' : 'WEAK';
  } else if (bearScore > bullScore && bearScore >= 2) {
    signal = 'SELL';
    strength = diff >= 3 ? 'STRONG' : diff >= 1.5 ? 'MODERATE' : 'WEAK';
  }

  const trend = ma5 !== null && ma20 !== null
    ? (ma5 > ma20 * 1.0005 ? 'UPTREND' : ma5 < ma20 * 0.9995 ? 'DOWNTREND' : 'SIDEWAYS')
    : 'SIDEWAYS';

  const pattern = detectPattern(candles);

  // estimasi entry/SL/TP sederhana berbasis ATR kasar (range rata-rata)
  const avgRange = average(candles.slice(-10).map(c => c.high - c.low));
  const decimals = pair.includes('JPY') ? 2 : 5;
  let entry = lastClose;
  let sl, tp;
  if (signal === 'BUY') {
    sl = lastClose - avgRange * 1.5;
    tp = lastClose + avgRange * 2.5;
  } else if (signal === 'SELL') {
    sl = lastClose + avgRange * 1.5;
    tp = lastClose - avgRange * 2.5;
  } else {
    sl = null;
    tp = null;
  }

  const summaryParts = [reasons.join(', ')];
  if (rsiNote) summaryParts.push(rsiNote);
  if (breakoutNote) summaryParts.push(breakoutNote);

  return {
    signal,
    strength,
    trend,
    pattern,
    entry: entry.toFixed(decimals),
    sl: sl !== null ? sl.toFixed(decimals) : null,
    tp: tp !== null ? tp.toFixed(decimals) : null,
    summary: `${summaryParts.join('. ')}. RSI: ${rsiValue !== null ? rsiValue.toFixed(1) : 'N/A'}.`,
    risk: strength === 'STRONG' ? 'MEDIUM' : strength === 'MODERATE' ? 'MEDIUM' : 'HIGH',
    indicators: {
      ma5: ma5 !== null ? ma5.toFixed(decimals) : null,
      ma10: ma10 !== null ? ma10.toFixed(decimals) : null,
      ma20: ma20 !== null ? ma20.toFixed(decimals) : null,
      rsi: rsiValue !== null ? rsiValue.toFixed(1) : null
    }
  };
}

export { analyzeTechnical, sma, rsi };
