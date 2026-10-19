import { getInstrument, simulateQuote } from "./market";
import { yahooSymbolForInstrument } from "./yahoo";
import { deltaCandles } from "./data/delta";
import type { Candle } from "./indicators";

/** Historical OHLCV candles: Yahoo Finance chart API → deterministic simulator fallback. */
export type Interval = "1m" | "3m" | "5m" | "15m" | "30m" | "60m" | "1d";
export const INTERVALS: { id: Interval; label: string; range: string; minutes: number }[] = [
  { id: "1m", label: "1m", range: "2d", minutes: 1 },
  { id: "3m", label: "3m", range: "5d", minutes: 3 },
  { id: "5m", label: "5m", range: "5d", minutes: 5 },
  { id: "15m", label: "15m", range: "1mo", minutes: 15 },
  { id: "30m", label: "30m", range: "1mo", minutes: 30 },
  { id: "60m", label: "1h", range: "3mo", minutes: 60 },
  { id: "1d", label: "1D", range: "1y", minutes: 1440 },
];

export interface CandleSet {
  symbol: string;
  interval: Interval;
  candles: Candle[];
  source: "yahoo" | "delta" | "simulated";
  yahooSymbol?: string;
  fetchedAt: number;
}

type CacheEntry = { set: CandleSet; expires: number };
const g = globalThis as unknown as { __algodeskCandles?: Map<string, CacheEntry> };
const cache: Map<string, CacheEntry> = (g.__algodeskCandles ??= new Map());
const TTL: Record<Interval, number> = { "1m": 30_000, "3m": 45_000, "5m": 60_000, "15m": 120_000, "30m": 180_000, "60m": 300_000, "1d": 900_000 };

type YahooChart = {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
};

/** Aggregates fine candles into N-minute buckets (used for 3m, which Yahoo lacks). */
function aggregate(candles: Candle[], minutes: number): Candle[] {
  const ms = minutes * 60_000;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles) {
    const bucket = Math.floor(c.t / ms) * ms;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function fetchYahooCandles(yahooSymbol: string, interval: Interval): Promise<Candle[] | null> {
  const yInterval = interval === "3m" ? "1m" : interval;
  const range = INTERVALS.find((x) => x.id === interval)?.range ?? "1mo";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${yInterval}&includePrePost=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36", Accept: "application/json" }, cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as YahooChart;
    const r = j.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    const ts = r?.timestamp;
    if (!r || !q || !ts?.length) return null;
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      if (o == null || h == null || l == null || c == null || !Number.isFinite(c) || c <= 0) continue;
      out.push({ t: ts[i] * 1000, o, h, l, c, v: q.volume?.[i] ?? 0 });
    }
    const final = interval === "3m" ? aggregate(out, 3) : out;
    return final.length >= 30 ? final : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rand01(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic synthetic candles ending at the current price (used when Yahoo has no data). */
function simulatedCandles(symbol: string, interval: Interval, lastPrice: number, volatility: number, count = 400): Candle[] {
  const stepMs = (INTERVALS.find((x) => x.id === interval)?.minutes ?? 15) * 60_000;
  const seed = hash(`${symbol}:${interval}`);
  const perBar = (volatility / Math.sqrt(252)) * (interval === "1d" ? 1 : Math.sqrt((INTERVALS.find((x) => x.id === interval)?.minutes ?? 15) / 375));
  const closes: number[] = [lastPrice];
  for (let i = 1; i < count; i++) {
    const r = rand01(seed + i * 7) - 0.5;
    closes.push(Math.max(0.05, closes[i - 1] * (1 - r * perBar * 2)));
  }
  closes.reverse(); // oldest → newest, ending at lastPrice
  const now = Date.now();
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    const wick = c * perBar * 0.6;
    return {
      t: now - (count - 1 - i) * stepMs,
      o: +o.toFixed(2),
      h: +(Math.max(o, c) + wick * rand01(seed + i * 13)).toFixed(2),
      l: +(Math.min(o, c) - wick * rand01(seed + i * 17)).toFixed(2),
      c: +c.toFixed(2),
      v: Math.floor(100_000 + rand01(seed + i * 19) * 900_000),
    };
  });
}

export async function getCandles(symbol: string, interval: Interval = "15m"): Promise<CandleSet | null> {
  const key = `${symbol}:${interval}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.set;

  const inst = await getInstrument(symbol);
  if (!inst) return null;
  let candles: Candle[] | null = null;
  let source: CandleSet["source"] = "yahoo";
  let ySym: string | null = null;
  if (inst.exchange === "DELTA") {
    candles = await deltaCandles(symbol, interval);
    source = "delta";
  } else {
    ySym = yahooSymbolForInstrument(inst);
    candles = ySym ? await fetchYahooCandles(ySym, interval) : null;
  }
  if (!candles) {
    source = "simulated";
    const q = simulateQuote(inst.symbol, inst.basePrice, inst.volatility);
    candles = simulatedCandles(inst.symbol, interval, q.ltp, inst.volatility);
  }
  const set: CandleSet = { symbol, interval, candles, source, yahooSymbol: ySym ?? undefined, fetchedAt: Date.now() };
  if (cache.size > 600) cache.clear();
  cache.set(key, { set, expires: Date.now() + TTL[interval] });
  return set;
}

/** Replaces the last candle close with the live broker/Yahoo LTP so signals react immediately. */
export function applyLivePrice(candles: Candle[], ltp?: number | null): Candle[] {
  if (!ltp || !candles.length) return candles;
  const out = candles.slice();
  const lastBar = { ...out[out.length - 1] };
  lastBar.c = ltp;
  lastBar.h = Math.max(lastBar.h, ltp);
  lastBar.l = Math.min(lastBar.l, ltp);
  out[out.length - 1] = lastBar;
  return out;
}
