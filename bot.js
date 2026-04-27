import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import express from "express";

// ─── EXPRESS WEBHOOK SERVER ───────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Claude Trading Bot is running ✅");
});

const BIAS_FILE = "market-bias.json";

// Load/save the current 4H market bias so the 5min alert can verify alignment.
function loadBias() {
  if (!existsSync(BIAS_FILE)) return { bias: "unclear", updatedAt: null };
  return JSON.parse(readFileSync(BIAS_FILE, "utf8"));
}
function saveBias(bias, price) {
  writeFileSync(BIAS_FILE, JSON.stringify({ bias, price, updatedAt: new Date().toISOString() }, null, 2));
}

// Parses TradingView alert payloads into a normalised signal object.
// Supports three alert types from the Elder Santis Pine scripts:
//   1. 4H bias   : { "action": "bias",  "bias": "bullish"|"bearish", ... }
//   2. 5min shift: { "action": "buy"|"sell", "signal": "5min_structure_shift", ... }
//   3. Generic   : { "action": "buy"|"sell", ... }
function parseTradingViewAlert(body) {
  if (!body || typeof body !== "object") return null;
  const action = (body.action || "").toLowerCase();
  const rawSymbol = body.symbol || body.ticker || "";
  const symbol = rawSymbol.includes(":") ? rawSymbol.split(":")[1] : rawSymbol || null;
  const price = parseFloat(body.close || body.price || 0) || null;

  // 4H bias update — do not execute a trade, just update state
  if (action === "bias") {
    return { type: "bias", bias: (body.bias || "unclear").toLowerCase(), symbol, price, raw: body };
  }

  // Trade signal (5min structure shift or generic)
  const side = action === "buy" || action === "long" ? "BUY"
             : action === "sell" || action === "short" ? "SELL"
             : null;
  const signalName = body.signal || null;
  return { type: "trade", side, signalName, symbol, price, raw: body };
}

app.post("/webhook", async (req, res) => {
  const signal = parseTradingViewAlert(req.body);
  console.log("\n📡 Webhook received:", JSON.stringify(req.body));
  res.json({ status: "received", timestamp: new Date().toISOString() });

  try {
    if (!signal) {
      console.log("   ↳ Could not parse alert body — ignoring.");
      return;
    }

    // ── 4H BIAS UPDATE ────────────────────────────────────────────────
    if (signal.type === "bias") {
      saveBias(signal.bias, signal.price);
      console.log(`   ↳ 4H bias updated → ${signal.bias.toUpperCase()} @ ${signal.price || "?"}`);
      console.log(`   ↳ No trade execution for bias alerts.`);
      return;
    }

    // ── TRADE SIGNAL ──────────────────────────────────────────────────
    if (signal.type === "trade" && signal.side) {
      const bias = loadBias();
      console.log(`   ↳ Trade signal: ${signal.side} ${signal.symbol || ""} @ ${signal.price || "market"}`);
      if (signal.signalName) console.log(`   ↳ Signal type: ${signal.signalName}`);
      console.log(`   ↳ Current 4H bias: ${bias.bias.toUpperCase()} (updated ${bias.updatedAt || "never"})`);

      // Warn if trade direction conflicts with stored 4H bias
      if (bias.bias !== "unclear") {
        const biasFits =
          (signal.side === "BUY"  && bias.bias === "bullish") ||
          (signal.side === "SELL" && bias.bias === "bearish");
        if (!biasFits) {
          console.log(`   ⚠️  Signal direction (${signal.side}) conflicts with 4H bias (${bias.bias}) — running safety check anyway.`);
        }
      }

      await run(signal);
      return;
    }

    console.log("   ↳ No actionable signal found in payload.");
  } catch (err) {
    console.error("Bot error from webhook:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Claude Trading Bot listening on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/`);
  console.log(`   Webhook endpoint: http://localhost:${PORT}/webhook`);
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "XAUUSD",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "10000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "2"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeSizeLots: parseFloat(process.env.TRADE_SIZE_LOTS || "0.1"),
  webhooktrade: {
    username: process.env.WEBHOOKTRADE_USERNAME,
    apiKey: process.env.WEBHOOKTRADE_API_KEY,
    url: process.env.WEBHOOKTRADE_URL,
  },
};

const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced
  ).length;
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

// Fetches the live XAUUSD spot price via TradingView's public global scanner.
// Returns null on failure so the caller can fall back to Yahoo Finance closes.
async function fetchTradingViewPrice(tvSymbol = "FX:XAUUSD") {
  try {
    const res = await fetch("https://scanner.tradingview.com/global/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "tradingview-mcp-server/0.6.1" },
      body: JSON.stringify({
        filter: [],
        columns: ["close", "open", "high", "low"],
        sort: { sortBy: "name", sortOrder: "asc" },
        range: [0, 1],
        options: { lang: "en" },
        symbols: { query: { types: [] }, tickers: [tvSymbol] },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.data?.[0]?.d;
    if (!row?.[0]) return null;
    return { price: row[0], open: row[1], high: row[2], low: row[3] };
  } catch {
    return null;
  }
}

async function fetchCandles(symbol) {
  if (symbol === "XAUUSD") {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1h&range=7d"
    );
    if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);
    const data = await res.json();
    const result = data.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    const highs = result.indicators.quote[0].high;
    const lows = result.indicators.quote[0].low;
    const volumes = result.indicators.quote[0].volume;

    return timestamps
      .map((t, i) => ({
        time: t * 1000,
        open: closes[i],
        high: highs[i],
        low: lows[i],
        close: closes[i],
        volume: volumes[i] || 1,
      }))
      .filter((c) => c.close !== null);
  }

  // Fallback: Binance for crypto
  const intervalMap = { "1H": "1h", "4H": "4h", "1D": "1d", "15m": "15m" };
  const binanceInterval = intervalMap[CONFIG.timeframe] || "1h";
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── SAFETY CHECK (Elder Santis Rules) ────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    check("Price above VWAP", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(8)", `> ${ema8.toFixed(2)}`, price.toFixed(2), price > ema8);
    check("RSI(3) below 30", "< 30", rsi3.toFixed(2), rsi3 < 30);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Within 1.5% of VWAP", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    check("Price below VWAP", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    check("Price below EMA(8)", `< ${ema8.toFixed(2)}`, price.toFixed(2), price < ema8);
    check("RSI(3) above 70", "> 70", rsi3.toFixed(2), rsi3 > 70);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Within 1.5% of VWAP", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  return { results, allPass: results.every((r) => r.pass) };
}

// ─── TRADE LIMITS ─────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }

  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);
  return true;
}

// ─── WEBHOOKTRADE EXECUTION ───────────────────────────────────────────────────

async function placeWebhookTradeOrder(symbol, side, lots) {
  const res = await fetch(CONFIG.webhooktrade.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: CONFIG.webhooktrade.username,
      api_key: CONFIG.webhooktrade.apiKey,
      action: side,
      symbol: symbol,
      volume: lots.toString(),
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`WebhookTrade error: ${JSON.stringify(data)}`);
  return data;
}

// ─── CSV LOGGING ──────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side",
  "Lots", "Price", "Order ID", "Mode", "Notes"
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const mode = !logEntry.allPass ? "BLOCKED" : logEntry.paperTrading ? "PAPER" : "LIVE";
  const notes = !logEntry.allPass
    ? `Failed: ${logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ")}`
    : logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";

  const row = [
    date, time, "Coinexx", logEntry.symbol,
    logEntry.allPass ? "BUY" : "",
    logEntry.allPass ? CONFIG.tradeSizeLots : "",
    logEntry.price.toFixed(2),
    logEntry.orderId || "",
    mode,
    `"${notes}"`
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`📄 Trade record saved → ${CSV_FILE}`);
}

// ─── MAIN BOT LOGIC ───────────────────────────────────────────────────────────

async function run(tvSignal = null) {
  initCsv();

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — WebhookTrade + Coinexx Edition");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  if (tvSignal?.side) console.log(`  Source: TradingView alert (${tvSignal.side})`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();
  if (!checkTradeLimits(log)) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  console.log("\n── Fetching market data ────────────────────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol);
  const closes = candles.map((c) => c.close);

  // Prefer live TradingView price when available; fall back to Yahoo Finance last close.
  const tvQuote = CONFIG.symbol === "XAUUSD" ? await fetchTradingViewPrice("FX:XAUUSD") : null;
  // If TradingView alert carried a price, prefer that; then TV live quote; then candle close.
  const price = (tvSignal?.price && tvSignal.price > 0)
    ? tvSignal.price
    : (tvQuote?.price ?? closes[closes.length - 1]);

  const priceSource = (tvSignal?.price && tvSignal.price > 0) ? "TradingView alert"
    : tvQuote ? "TradingView live"
    : "Yahoo Finance";
  console.log(`  Current XAUUSD price: $${price.toFixed(2)} (${priceSource})`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8): $${ema8.toFixed(2)}`);
  console.log(`  VWAP:   $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3): ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    priceSource,
    tvSignal: tvSignal ?? undefined,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would send ${CONFIG.tradeSizeLots} lots BUY ${CONFIG.symbol} to Coinexx`);
      console.log(`   (Set PAPER_TRADING=false in Railway variables to go live)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — ${CONFIG.tradeSizeLots} lots BUY ${CONFIG.symbol}`);
      try {
        const order = await placeWebhookTradeOrder(CONFIG.symbol, "buy", CONFIG.tradeSizeLots);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.order_id || `WT-${Date.now()}`;
        console.log(`✅ ORDER PLACED — ${logEntry.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  writeTradeCsv(logEntry);
  console.log("═══════════════════════════════════════════════════════════\n");
}