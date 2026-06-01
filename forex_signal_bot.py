"""
Forex Signal Bot - Versi Twelve Data
======================================
- Data 15 menit dari Twelve Data (gratis)
- Analisis RSI, MACD, EMA
- Kirim email notifikasi saat BUY/SELL
- Jalan sekali lalu berhenti (GitHub Actions)
"""

import requests
import pandas as pd
import smtplib
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime

# Ambil dari GitHub Secrets
EMAIL_PENGIRIM  = os.environ.get("EMAIL_PENGIRIM", "")
EMAIL_PASSWORD  = os.environ.get("EMAIL_PASSWORD", "")
EMAIL_PENERIMA  = os.environ.get("EMAIL_PENERIMA", "")
TWELVE_API_KEY  = os.environ.get("TWELVE_API_KEY", "")

PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY"]

# ============================================================
# AMBIL DATA FOREX - Twelve Data
# ============================================================

def ambil_data_forex(pair):
    symbol = pair.replace("/", "")
    url = (
        f"https://api.twelvedata.com/time_series"
        f"?symbol={pair}"
        f"&interval=15min"
        f"&outputsize=100"
        f"&apikey={TWELVE_API_KEY}"
    )
    resp = requests.get(url, timeout=10)
    data = resp.json()

    if "values" not in data:
        print(f"  [ERROR] {data.get('message', data)}")
        return None

    rows = []
    for item in data["values"]:
        rows.append({
            "time":  item["datetime"],
            "open":  float(item["open"]),
            "high":  float(item["high"]),
            "low":   float(item["low"]),
            "close": float(item["close"]),
        })

    df = pd.DataFrame(rows).sort_values("time").reset_index(drop=True)
    return df

# ============================================================
# INDIKATOR
# ============================================================

def hitung_indikator(df):
    delta        = df["close"].diff()
    gain         = delta.clip(lower=0).rolling(14).mean()
    loss         = (-delta.clip(upper=0)).rolling(14).mean()
    df["rsi"]    = 100 - (100 / (1 + gain / loss))
    ema12        = df["close"].ewm(span=12, adjust=False).mean()
    ema26        = df["close"].ewm(span=26, adjust=False).mean()
    df["macd"]   = ema12 - ema26
    df["signal"] = df["macd"].ewm(span=9, adjust=False).mean()
    df["ema20"]  = df["close"].ewm(span=20, adjust=False).mean()
    return df.dropna()

# ============================================================
# ANALISIS SINYAL
# ============================================================

def analisis_sinyal(df):
    now  = df.iloc[-1]
    prev = df.iloc[-2]
    rsi, macd, sig = now["rsi"], now["macd"], now["signal"]
    harga, ema20   = now["close"], now["ema20"]
    sinyal, kekuatan, alasan = "HOLD", "LEMAH", []

    if rsi < 35 and macd > sig and prev["macd"] <= prev["signal"]:
        sinyal = "BUY"
        alasan = [f"RSI oversold ({rsi:.1f})", "MACD crossover bullish"]
        kekuatan = "KUAT" if harga > ema20 else "SEDANG"
    elif rsi > 65 and macd < sig and prev["macd"] >= prev["signal"]:
        sinyal = "SELL"
        alasan = [f"RSI overbought ({rsi:.1f})", "MACD crossover bearish"]
        kekuatan = "KUAT" if harga < ema20 else "SEDANG"

    spread = abs(now["high"] - now["low"])
    sl = round(harga - spread*1.5, 5) if sinyal=="BUY" else round(harga + spread*1.5, 5) if sinyal=="SELL" else "-"
    tp = round(harga + spread*2.5, 5) if sinyal=="BUY" else round(harga - spread*2.5, 5) if sinyal=="SELL" else "-"

    return {"sinyal": sinyal, "kekuatan": kekuatan,
            "alasan": ", ".join(alasan) or "Tidak ada sinyal",
            "harga": harga, "rsi": rsi, "stop_loss": sl, "take_profit": tp}

# ============================================================
# KIRIM EMAIL
# ============================================================

def kirim_email(pair, h):
    emoji = "🟢" if h["sinyal"]=="BUY" else "🔴"
    warna = "#16a34a" if h["sinyal"]=="BUY" else "#dc2626"
    waktu = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    subjek = f"{emoji} SINYAL {h['sinyal']} {h['kekuatan']} — {pair} | {waktu}"
    html = f"""<html><body style="font-family:Arial;background:#f5f5f5;padding:20px;">
<div style="max-width:500px;margin:auto;background:white;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <h2 style="color:{warna};margin-top:0;">{emoji} {h['sinyal']} — {pair}</h2>
  <table style="width:100%;font-size:15px;">
    <tr><td style="color:#888;padding:8px 0">Kekuatan</td><td><b>{h['kekuatan']}</b></td></tr>
    <tr><td style="color:#888;padding:8px 0">Harga</td><td><b>{h['harga']:.5f}</b></td></tr>
    <tr><td style="color:#888;padding:8px 0">RSI</td><td><b>{h['rsi']:.2f}</b></td></tr>
    <tr><td style="color:#dc2626;padding:8px 0">Stop Loss</td><td><b style="color:#dc2626">{h['stop_loss']}</b></td></tr>
    <tr><td style="color:#16a34a;padding:8px 0">Take Profit</td><td><b style="color:#16a34a">{h['take_profit']}</b></td></tr>
    <tr><td style="color:#888;padding:8px 0">Alasan</td><td><i>{h['alasan']}</i></td></tr>
  </table>
  <p style="font-size:11px;color:#aaa;margin-top:16px">⚠️ Bukan saran finansial. Waktu: {waktu}</p>
</div></body></html>"""
    msg = MIMEMultipart("alternative")
    msg["Subject"], msg["From"], msg["To"] = subjek, EMAIL_PENGIRIM, EMAIL_PENERIMA
    msg.attach(MIMEText(html, "html"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(EMAIL_PENGIRIM, EMAIL_PASSWORD)
        s.sendmail(EMAIL_PENGIRIM, EMAIL_PENERIMA, msg.as_string())
    print(f"  ✅ Email terkirim!")

# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    print(f"🚀 Forex Signal Bot (Twelve Data - 15 menit)")
    print(f"📌 Memantau: {', '.join(PAIRS)}")
    print(f"⏰ {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}\n")

    for pair in PAIRS:
        print(f"📊 Analisis {pair}...")
        try:
            df = ambil_data_forex(pair)
            if df is None or len(df) < 30:
                print("  ⚠️ Data tidak cukup"); continue
            df = hitung_indikator(df)
            h  = analisis_sinyal(df)
            print(f"  Sinyal : {h['sinyal']} ({h['kekuatan']})")
            print(f"  Harga  : {h['harga']:.5f} | RSI: {h['rsi']:.2f}")
            print(f"  Alasan : {h['alasan']}")
            if h["sinyal"] in ("BUY", "SELL"):
                kirim_email(pair, h)
            else:
                print("  ℹ️ HOLD - tidak ada sinyal")
        except Exception as e:
            print(f"  ❌ Error: {e}")

    print("\n✅ Selesai!")
