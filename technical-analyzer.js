// Modul analisis teknikal dengan indikator lengkap untuk XAU/USD
// MACD, Bollinger Bands, EMA, Stochastic, ATR, RSI

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// === EMA (Exponential Moving Average) ===
function ema(closes, period) {
  if (closes.length < period) return null; // butuh minimal `period` data
  const k = 2 / (period + 1);
  let emaVal = average(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) {
    emaVal = closes[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

// === SMA ===
function sma(closes, period) {
  if (closes.length < period) return null;
  return average(closes.slice(-period));
}

// === RSI ===
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// === MACD ===
function macd(closes) {
  if (closes.length < 35) return null; // butuh minimal 35 untuk sinyal akurat
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = ema12 - ema26;
  const macdValues = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = ema(closes.slice(0, i), 12);
    const e26 = ema(closes.slice(0, i), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  const signalLine = macdValues.length >= 9 ? ema(macdValues, 9) : null;
  const histogram = signalLine !== null ? macdLine - signalLine : null;
  return { macdLine, signalLine, histogram };
}

// === Bollinger Bands ===
function bollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = average(slice);
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mid, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mid + multiplier * std,
    middle: mid,
    lower: mid - multiplier * std,
    bandwidth: ((multiplier * 2 * std) / mid) * 100,
  };
}

// === Stochastic ===
function stochastic(candles, period = 14) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const highestHigh = Math.max(...slice.map((c) => c.high));
  const lowestLow = Math.min(...slice.map((c) => c.low));
  const lastClose = candles[candles.length - 1].close;
  if (highestHigh === lowestLow) return 50;
  return ((lastClose - lowestLow) / (highestHigh - lowestLow)) * 100;
}

// === ATR (Average True Range) ===
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trValues.push(tr);
  }
  return average(trValues.slice(-period));
}

// === Deteksi pola candle ===
function detectPattern(candles) {
  const last3 = candles.slice(-3);
  if (last3.length < 3) return "Data belum cukup";
  const [a, b, c] = last3;
  const aBull = a.close > a.open;
  const bBull = b.close > b.open;
  const cBull = c.close > c.open;
  if (!aBull && !bBull && cBull && c.close > a.open) return "Reversal bullish (3 candle)";
  if (aBull && bBull && !cBull && c.close < a.open) return "Reversal bearish (3 candle)";
  if (aBull && bBull && cBull) return "Tiga candle bullish berurutan";
  if (!aBull && !bBull && !cBull) return "Tiga candle bearish berurutan";
  const bodyC = Math.abs(c.close - c.open);
  const rangeC = c.high - c.low;
  if (rangeC > 0 && bodyC / rangeC < 0.3) return "Doji / indecision candle";
  return "Tidak ada pola dominan";
}

// === Fungsi utama analisis ===
function analyzeTechnical(candles, pair, timeframe) {
  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2] || lastClose;
  const decimals = pair.includes("JPY") ? 2 : pair.includes("XAU") ? 2 : 5;

  // Hitung semua indikator
  const ma5   = sma(closes, 5);
  const ma10  = sma(closes, 10);
  const ma20  = sma(closes, 20);
  const ema50  = ema(closes, 50);   // FIXED: tidak pakai Math.min
  const ema200 = ema(closes, 200);  // FIXED: tidak pakai Math.min
  const rsiValue  = rsi(closes, 14);
  const macdData  = macd(closes);
  const bb        = bollingerBands(closes, 20);
  const stoch     = stochastic(candles, 14);
  const atrValue  = atr(candles, 14);
  const pattern   = detectPattern(candles);

  // === Scoring per indikator ===
  let bullScore = 0;
  let bearScore = 0;
  const reasons = [];
  const signals = [];

  // 1. MA Crossover (MA5 vs MA10)
  if (ma5 !== null && ma10 !== null) {
    if (ma5 > ma10) {
      bullScore++;
      signals.push("MA_BULL");
      reasons.push("MA5 > MA10");
    } else {
      bearScore++;
      signals.push("MA_BEAR");
      reasons.push("MA5 < MA10");
    }
  }

  // 2. EMA50 trend
  if (ema50 !== null) {
    if (lastClose > ema50) {
      bullScore += 1.5;
      signals.push("EMA50_BULL");
      reasons.push("harga di atas EMA50");
    } else {
      bearScore += 1.5;
      signals.push("EMA50_BEAR");
      reasons.push("harga di bawah EMA50");
    }
  }

  // 3. EMA200 trend jangka panjang
  if (ema200 !== null) {
    if (lastClose > ema200) {
      bullScore += 2;
      signals.push("EMA200_BULL");
      reasons.push("harga di atas EMA200 (uptrend)");
    } else {
      bearScore += 2;
      signals.push("EMA200_BEAR");
      reasons.push("harga di bawah EMA200 (downtrend)");
    }
  }

  // 4. RSI
  let rsiNote = "";
  if (rsiValue !== null) {
    if (rsiValue < 30) {
      bullScore += 2;
      signals.push("RSI_BULL");
      rsiNote = "RSI oversold";
    } else if (rsiValue > 70) {
      bearScore += 2;
      signals.push("RSI_BEAR");
      rsiNote = "RSI overbought";
    } else if (rsiValue >= 50) {
      bullScore += 0.5;
      rsiNote = `RSI ${rsiValue.toFixed(1)} (bullish zone)`;
    } else {
      bearScore += 0.5;
      rsiNote = `RSI ${rsiValue.toFixed(1)} (bearish zone)`;
    }
  }

  // 5. MACD
  let macdNote = "";
  if (macdData) {
    if (macdData.histogram !== null) {
      if (macdData.histogram > 0 && macdData.macdLine > 0) {
        bullScore += 1.5;
        signals.push("MACD_BULL");
        macdNote = "MACD bullish";
      } else if (macdData.histogram < 0 && macdData.macdLine < 0) {
        bearScore += 1.5;
        signals.push("MACD_BEAR");
        macdNote = "MACD bearish";
      } else if (macdData.histogram > 0) {
        bullScore += 0.5;
        macdNote = "MACD histogram positif";
      } else {
        bearScore += 0.5;
        macdNote = "MACD histogram negatif";
      }
    }
  }

  // 6. Bollinger Bands
  let bbNote = "";
  if (bb) {
    if (lastClose <= bb.lower) {
      bullScore += 1.5;
      signals.push("BB_BULL");
      bbNote = "harga di lower BB (oversold)";
    } else if (lastClose >= bb.upper) {
      bearScore += 1.5;
      signals.push("BB_BEAR");
      bbNote = "harga di upper BB (overbought)";
    } else if (lastClose < bb.middle) {
      bearScore += 0.3;
      bbNote = "harga di bawah mid BB";
    } else {
      bullScore += 0.3;
      bbNote = "harga di atas mid BB";
    }
  }

  // 7. Stochastic
  let stochNote = "";
  if (stoch !== null) {
    if (stoch < 20) {
      bullScore += 1.5;
      signals.push("STOCH_BULL");
      stochNote = "Stochastic oversold";
    } else if (stoch > 80) {
      bearScore += 1.5;
      signals.push("STOCH_BEAR");
      stochNote = "Stochastic overbought";
    } else if (stoch >= 50) {
      bullScore += 0.3;
      stochNote = `Stochastic ${stoch.toFixed(1)}`;
    } else {
      bearScore += 0.3;
      stochNote = `Stochastic ${stoch.toFixed(1)}`;
    }
  }

  // === Tentukan sinyal ===
  const bullSignalCount = signals.filter((s) => s.includes("BULL")).length;
  const bearSignalCount = signals.filter((s) => s.includes("BEAR")).length;
  const diff = Math.abs(bullScore - bearScore);

  let signal = "NEUTRAL";
  let strength = "WEAK";

  if (bullScore > bearScore && bullSignalCount >= 3) {
    signal = "BUY";
    strength = diff >= 5 ? "STRONG" : diff >= 3 ? "MODERATE" : "WEAK";
  } else if (bearScore > bullScore && bearSignalCount >= 3) {
    signal = "SELL";
    strength = diff >= 5 ? "STRONG" : diff >= 3 ? "MODERATE" : "WEAK";
  }

  // Trend
  const trend =
    ema50 && ema200
      ? ema50 > ema200 * 1.001 ? "UPTREND" : ema50 < ema200 * 0.999 ? "DOWNTREND" : "SIDEWAYS"
      : ma5 && ma20
        ? ma5 > ma20 * 1.0005 ? "UPTREND" : ma5 < ma20 * 0.9995 ? "DOWNTREND" : "SIDEWAYS"
        : "SIDEWAYS";

  // SL/TP berbasis ATR
  const atrMul = atrValue || lastClose * 0.001;
  let entry = lastClose, sl = null, tp = null;
  if (signal === "BUY") {
    sl = lastClose - atrMul * 1.5;
    tp = lastClose + atrMul * 3;
  } else if (signal === "SELL") {
    sl = lastClose + atrMul * 1.5;
    tp = lastClose - atrMul * 3;
  }

  const summaryParts = [reasons.slice(0, 3).join(", ")];
  if (rsiNote) summaryParts.push(rsiNote);
  if (macdNote) summaryParts.push(macdNote);
  if (bbNote) summaryParts.push(bbNote);
  if (stochNote) summaryParts.push(stochNote);

  return {
    signal,
    strength,
    trend,
    pattern,
    entry: entry.toFixed(decimals),
    sl: sl !== null ? sl.toFixed(decimals) : null,
    tp: tp !== null ? tp.toFixed(decimals) : null,
    summary: summaryParts.join(". ") + `. RSI: ${rsiValue !== null ? rsiValue.toFixed(1) : "N/A"}.`,
    risk: strength === "STRONG" ? "LOW" : strength === "MODERATE" ? "MEDIUM" : "HIGH",
    indicators: {
      ma5:   ma5   !== null ? ma5.toFixed(decimals)   : null,
      ma10:  ma10  !== null ? ma10.toFixed(decimals)  : null,
      ma20:  ma20  !== null ? ma20.toFixed(decimals)  : null,
      ema50:  ema50  !== null ? ema50.toFixed(decimals)  : null,
      ema200: ema200 !== null ? ema200.toFixed(decimals) : null,
      rsi:  rsiValue  !== null ? rsiValue.toFixed(1)  : null,
      macd: macdData  ? macdData.macdLine.toFixed(decimals) : null,
      macdSignal:    macdData && macdData.signalLine  !== null ? macdData.signalLine.toFixed(decimals)  : null,
      macdHistogram: macdData && macdData.histogram   !== null ? macdData.histogram.toFixed(decimals)   : null,
      bbUpper:  bb ? bb.upper.toFixed(decimals)  : null,
      bbMiddle: bb ? bb.middle.toFixed(decimals) : null,
      bbLower:  bb ? bb.lower.toFixed(decimals)  : null,
      stochastic: stoch !== null ? stoch.toFixed(1) : null,
      atr: atrValue !== null ? atrValue.toFixed(decimals) : null,
    },
  };
}

export { analyzeTechnical, sma, ema, rsi, macd, bollingerBands, stochastic, atr };
