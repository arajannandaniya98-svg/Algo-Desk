import { db } from "@/db";
import { instruments, type Instrument } from "@/db/schema";
import { SEED_INSTRUMENTS } from "./seed-data";
import { sql, inArray } from "drizzle-orm";
import { yahooQuotes } from "./yahoo";
import { liveQuotesFor, liveTickFor } from "./feed/live";
import { deltaQuotesFor, deltaPriceFor } from "./feed/delta-quotes";

// ---------- deterministic pseudo-random ----------
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
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

export interface Quote {
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  oi?: number;
  ts: number;
  source?: "yahoo" | "simulated" | "live";
  provider?: string;
  latencyMs?: number | null;
  yahooSymbol?: string;
  delayedMinutes?: number;
  marketState?: string;
  currency?: string;
}

/**
 * Simulated live price: a smooth intraday random walk that is deterministic
 * per symbol + day, plus a small tick-level jitter. Replace with broker
 * WebSocket feed for real-time data.
 */
export function simulateQuote(symbol: string, basePrice: number, volatility = 0.2, now = Date.now()): Quote {
  const dayKey = Math.floor(now / 86400000);
  const seed = hash(symbol) ^ dayKey;
  const dayDrift = (rand01(seed) - 0.5) * 2 * volatility * 0.12; // daily move
  const prevClose = basePrice * (1 + (rand01(seed + 7) - 0.5) * volatility * 0.05);
  const open = prevClose * (1 + (rand01(seed + 11) - 0.5) * volatility * 0.03);

  const minuteOfDay = Math.floor((now % 86400000) / 60000);
  // random walk through minutes using sum of low-freq sines for smoothness
  const p1 = rand01(seed + 21) * Math.PI * 2;
  const p2 = rand01(seed + 31) * Math.PI * 2;
  const p3 = rand01(seed + 41) * Math.PI * 2;
  const t = minuteOfDay / 1440;
  const wave =
    Math.sin(t * Math.PI * 2 * 1.3 + p1) * 0.5 +
    Math.sin(t * Math.PI * 2 * 3.7 + p2) * 0.3 +
    Math.sin(t * Math.PI * 2 * 9.1 + p3) * 0.2;
  const tickJitter = (rand01(seed ^ Math.floor(now / 3000)) - 0.5) * volatility * 0.004;
  const ltpRaw = open * (1 + dayDrift * t + wave * volatility * 0.04 + tickJitter);
  const ltp = roundTick(ltpRaw);

  const high = roundTick(Math.max(open, ltp) * (1 + volatility * 0.01));
  const low = roundTick(Math.min(open, ltp) * (1 - volatility * 0.01));
  const change = ltp - prevClose;
  const volume = Math.floor((rand01(seed + 51) * 5 + 0.5) * 1_000_000 * (0.2 + t));

  return {
    symbol,
    ltp,
    open: roundTick(open),
    high,
    low,
    prevClose: roundTick(prevClose),
    change: +change.toFixed(2),
    changePct: +((change / prevClose) * 100).toFixed(2),
    volume,
    ts: now,
    source: "simulated",
    delayedMinutes: 0,
  };
}

export function roundTick(p: number): number {
  if (p < 100) return Math.round(p * 100) / 100;
  return Math.round(p * 20) / 20; // 0.05 tick
}

// ---------- seeding ----------
let seededPromise: Promise<void> | null = null;
export function ensureSeeded(): Promise<void> {
  if (!seededPromise) {
    seededPromise = (async () => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(instruments);
      if (Number(count) > 0) {
        // upgrade older installs: add crypto instruments if missing
        const crypto = SEED_INSTRUMENTS.filter((x) => x[3] === "CRYPTO");
        if (crypto.length) {
          await db
            .insert(instruments)
            .values(
              crypto.map((r) => ({
                symbol: r[0], name: r[1], exchange: r[2], segment: r[3], sector: r[4], lotSize: r[5],
                basePrice: r[6], marketCap: r[7], pe: r[8], isFno: r[9], volatility: r[10],
                high52: roundTick(r[6] * 1.5), low52: roundTick(r[6] * 0.5),
              })),
            )
            .onConflictDoNothing();
        }
        // keep official index lot sizes in sync with seed master
        for (const r of SEED_INSTRUMENTS.filter((x) => x[3] === "INDEX")) {
          await db
            .update(instruments)
            .set({ lotSize: r[5] })
            .where(sql`${instruments.symbol} = ${r[0]} and ${instruments.lotSize} <> ${r[5]}`);
        }
        return;
      }
      await db
        .insert(instruments)
        .values(
          SEED_INSTRUMENTS.map((r) => ({
            symbol: r[0],
            name: r[1],
            exchange: r[2],
            segment: r[3],
            sector: r[4],
            lotSize: r[5],
            basePrice: r[6],
            marketCap: r[7],
            pe: r[8],
            isFno: r[9],
            volatility: r[10],
            high52: roundTick(r[6] * 1.28),
            low52: roundTick(r[6] * 0.72),
          })),
        )
        .onConflictDoNothing();
    })().catch((e) => {
      seededPromise = null;
      throw e;
    });
  }
  return seededPromise;
}

export async function getInstrument(symbol: string): Promise<Instrument | null> {
  await ensureSeeded();
  const rows = await db.select().from(instruments).where(sql`${instruments.symbol} = ${symbol}`).limit(1);
  return rows[0] ?? null;
}

export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  await ensureSeeded();
  if (symbols.length === 0) return {};
  const rows = await db.select().from(instruments).where(inArray(instruments.symbol, symbols));
  // priority: live broker tick (0 delay) → Delta crypto (live) → Yahoo (~15 min delayed) → simulator
  const crypto = rows.filter((r) => r.exchange === "DELTA");
  const rest = rows.filter((r) => r.exchange !== "DELTA");
  const [live, delta] = await Promise.all([liveQuotesFor(rest), deltaQuotesFor(crypto)]);
  const yahoo = await yahooQuotes(rest.filter((r) => !live[r.symbol]));
  const out: Record<string, Quote> = {};
  for (const r of rows) out[r.symbol] = live[r.symbol] ?? delta[r.symbol] ?? yahoo[r.symbol] ?? simulateQuote(r.symbol, r.basePrice, r.volatility);
  return out;
}

/** One live-first quote for server routes that need a spot before calculating. */
export async function getQuoteForInstrument(inst: Instrument): Promise<Quote> {
  if (inst.exchange === "DELTA") {
    const d = await deltaQuotesFor([inst]);
    if (d[inst.symbol]) return d[inst.symbol];
    return simulateQuote(inst.symbol, inst.basePrice, inst.volatility);
  }
  const live = await liveQuotesFor([inst]);
  if (live[inst.symbol]) return live[inst.symbol];
  const yahoo = await yahooQuotes([inst]);
  return yahoo[inst.symbol] ?? simulateQuote(inst.symbol, inst.basePrice, inst.volatility);
}

// ---------- Options: Black-Scholes ----------
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}
function normPdf(x: number) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface OptionLeg {
  ltp: number;
  change: number;
  changePct: number;
  oi: number;
  oiChange: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bid: number;
  ask: number;
  token?: string;
  key?: string;
  tradingSymbol?: string;
  live?: boolean;
}
export interface ChainRow {
  strike: number;
  ce: OptionLeg;
  pe: OptionLeg;
}

export function bsPrice(S: number, K: number, T: number, r: number, sigma: number, type: "CE" | "PE") {
  if (T <= 0) return { price: Math.max(type === "CE" ? S - K : K - S, 0), delta: 0, gamma: 0, theta: 0, vega: 0 };
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const price =
    type === "CE"
      ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
      : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  const delta = type === "CE" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (S * sigma * Math.sqrt(T));
  const vega = (S * normPdf(d1) * Math.sqrt(T)) / 100;
  const theta =
    ((-S * normPdf(d1) * sigma) / (2 * Math.sqrt(T)) -
      (type === "CE" ? 1 : -1) * r * K * Math.exp(-r * T) * normCdf(type === "CE" ? d2 : -d2)) /
    365;
  return { price, delta, gamma, theta, vega };
}

/** Implied volatility from a market premium (bisection on Black-Scholes). */
export function impliedVol(price: number, S: number, K: number, T: number, r: number, type: "CE" | "PE"): number | null {
  const intrinsic = Math.max(type === "CE" ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S, 0);
  if (!(price > intrinsic + 0.01) || T <= 0) return null;
  let lo = 0.01;
  let hi = 5;
  for (let i = 0; i < 60 && hi - lo > 1e-4; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, r, mid, type).price > price) hi = mid;
    else lo = mid;
  }
  const iv = (lo + hi) / 2;
  return iv > 0.011 && iv < 4.99 ? iv : null;
}

export function strikeStep(spot: number): number {
  if (spot > 50000) return 100;
  if (spot > 20000) return 50;
  if (spot > 8000) return 25;
  if (spot > 3000) return 50;
  if (spot > 1500) return 20;
  if (spot > 700) return 10;
  if (spot > 250) return 5;
  if (spot > 100) return 2.5;
  return 1;
}

/**
 * Fallback expiry calendar (used until a broker scrip master is synced, which
 * then provides the exact exchange expiries). Since Sep-2025: NSE weekly/monthly
 * on Tuesday (only NIFTY has weeklies), BSE on Thursday (SENSEX weekly).
 */
export function getExpiries(symbol: string, count = 6): string[] {
  const out: string[] = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekly: Record<string, number> = { NIFTY: 2, SENSEX: 4 };
  if (symbol in weekly) {
    const d = new Date(today);
    while (d.getDay() !== weekly[symbol]) d.setDate(d.getDate() + 1);
    for (let i = 0; i < count; i++) {
      out.push(fmtDate(d));
      d.setDate(d.getDate() + 7);
    }
    return out;
  }
  const dow = symbol === "BANKEX" ? 4 : 2;
  for (let i = 0; out.length < 3 && i < 6; i++) {
    const m = new Date(today.getFullYear(), today.getMonth() + i + 1, 0); // last day of month
    while (m.getDay() !== dow) m.setDate(m.getDate() - 1);
    if (m >= today) out.push(fmtDate(m));
  }
  return out;
}
function fmtDate(d: Date) {
  // local calendar date (toISOString would shift IST dates back by one day)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function buildOptionChain(symbol: string, spot: number, expiry: string, baseVol: number, strikesEachSide = 12, strikeList?: number[]): ChainRow[] {
  const step = strikeStep(spot);
  const atm = Math.round(spot / step) * step;
  const expiryDate = new Date(expiry + "T15:30:00+05:30");
  const T = Math.max((expiryDate.getTime() - Date.now()) / (365 * 86400000), 0.0005);
  const r = 0.07;
  const rows: ChainRow[] = [];
  const seed = hash(symbol + expiry);

  const list = strikeList?.length ? strikeList : Array.from({ length: strikesEachSide * 2 + 1 }, (_, n) => +(atm + (n - strikesEachSide) * step).toFixed(2));
  for (const K of list) {
    const i = Math.round((K - atm) / step);
    const moneyness = Math.log(K / spot);
    // volatility smile
    const smile = baseVol * (1 + 1.6 * moneyness * moneyness * 10 + (moneyness < 0 ? -0.15 * moneyness : 0.05 * moneyness));
    const ivC = Math.max(smile * (1 + (rand01(seed + i * 3) - 0.5) * 0.06), 0.05);
    const ivP = Math.max(smile * (1 + (rand01(seed + i * 5) - 0.5) * 0.06) * 1.03, 0.05);
    const ce = bsPrice(spot, K, T, r, ivC, "CE");
    const pe = bsPrice(spot, K, T, r, ivP, "PE");
    const distance = Math.abs(i);
    const oiBase = Math.exp(-distance / 5) * 4_000_000 + 50_000;
    const mk = (leg: ReturnType<typeof bsPrice>, iv: number, k: number, type: "CE" | "PE"): OptionLeg => {
      const ltp = Math.max(roundTick(leg.price), 0.05);
      const prev = ltp * (1 + (rand01(seed + k * 13 + (type === "CE" ? 1 : 2)) - 0.5) * 0.3);
      const oi = Math.floor(oiBase * (0.6 + rand01(seed + k * 17 + (type === "CE" ? 3 : 4)) * 0.8));
      return {
        ltp,
        change: +(ltp - prev).toFixed(2),
        changePct: +(((ltp - prev) / prev) * 100).toFixed(2),
        oi,
        oiChange: Math.floor((rand01(seed + k * 19 + (type === "CE" ? 5 : 6)) - 0.4) * oi * 0.3),
        volume: Math.floor(oi * (0.3 + rand01(seed + k * 23) * 1.2)),
        iv: +(iv * 100).toFixed(2),
        delta: +leg.delta.toFixed(3),
        gamma: +leg.gamma.toFixed(5),
        theta: +leg.theta.toFixed(2),
        vega: +leg.vega.toFixed(2),
        bid: Math.max(roundTick(ltp * 0.995), 0.05),
        ask: roundTick(ltp * 1.005),
      };
    };
    rows.push({ strike: K, ce: mk(ce, ivC, i + 100, "CE"), pe: mk(pe, ivP, i + 100, "PE") });
  }
  return rows;
}

/** Price for any tradeable: EQ/INDEX/FUT/CE/PE */
export async function priceFor(opts: {
  symbol: string;
  underlying?: string;
  instrumentType: string;
  strike?: number | null;
  expiry?: string;
  exchange?: string;
}): Promise<number | null> {
  if (opts.exchange === "DELTA" || /^[CP]-[A-Z0-9]+-\d/.test(opts.symbol)) {
    const d = await deltaPriceFor(opts.symbol, opts.underlying, opts.instrumentType, opts.strike, opts.expiry);
    if (d != null) return d;
  }
  const live = await liveTickFor({ symbol: opts.symbol, underlying: opts.underlying || opts.symbol, instrumentType: opts.instrumentType, strike: opts.strike, expiry: opts.expiry, exchange: opts.exchange });
  if (live) return live.ltp;
  const base = opts.underlying || opts.symbol;
  const inst = await getInstrument(base);
  if (!inst) return null;
  const q = await getQuoteForInstrument(inst);
  if (opts.instrumentType === "EQ" || opts.instrumentType === "INDEX") return q.ltp;
  if (opts.instrumentType === "FUT") return roundTick(q.ltp * 1.004);
  if ((opts.instrumentType === "CE" || opts.instrumentType === "PE") && opts.strike && opts.expiry) {
    const chain = buildOptionChain(inst.symbol, q.ltp, opts.expiry, inst.volatility, 40);
    const row = chain.find((c) => Math.abs(c.strike - opts.strike!) < 0.001);
    if (row) return opts.instrumentType === "CE" ? row.ce.ltp : row.pe.ltp;
    const expiryDate = new Date(opts.expiry + "T15:30:00+05:30");
    const T = Math.max((expiryDate.getTime() - Date.now()) / (365 * 86400000), 0.0005);
    return Math.max(roundTick(bsPrice(q.ltp, opts.strike, T, 0.07, inst.volatility, opts.instrumentType).price), 0.05);
  }
  return q.ltp;
}
