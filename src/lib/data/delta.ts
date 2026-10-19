import { createHmac } from "crypto";
import type { Candle } from "@/lib/indicators";

/**
 * Delta Exchange India (crypto F&O) — public market data + signed trading API.
 * REST  : https://api.india.delta.exchange   (tickers/candles/products are public)
 * WS    : wss://socket.india.delta.exchange  (see src/lib/feed/delta.ts)
 * Prices are in USD (settlement asset); INR conversion happens in capital guard.
 */
export const DELTA_BASE = "https://api.india.delta.exchange";
export const DELTA_WS = "wss://socket.india.delta.exchange";
export const DELTA_EXCHANGE = "DELTA";

export interface DeltaTicker {
  symbol: string;
  product_id: number;
  contract_type: string;
  close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  mark_price?: string;
  spot_price?: string;
  volume?: number;
  oi_contracts?: string;
  strike_price?: string;
  contract_value?: string;
  greeks?: { delta?: string; gamma?: string; theta?: string; vega?: string } | null;
  quotes?: { best_bid?: string; best_ask?: string; bid_iv?: string; ask_iv?: string; mark_iv?: string } | null;
  timestamp?: number;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function getJson<T>(path: string, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${DELTA_BASE}${path}`, { signal: ctrl.signal, cache: "no-store", headers: { Accept: "application/json", "User-Agent": "algodesk-india" } });
    if (!res.ok) throw new Error(`Delta HTTP ${res.status}`);
    const j = (await res.json()) as { success?: boolean; result?: T; error?: { code?: string } };
    if (j.success === false) throw new Error(`Delta error: ${JSON.stringify(j.error ?? {}).slice(0, 120)}`);
    return (j.result ?? j) as T;
  } finally {
    clearTimeout(t);
  }
}

// ---------- cached public tickers ----------
type Cache = { perps: { at: number; map: Map<string, DeltaTicker> } | null; chains: Map<string, { at: number; rows: DeltaTicker[] }>; ids: Map<string, number> };
const g = globalThis as unknown as { __algodeskDelta?: Cache };
const C: Cache = (g.__algodeskDelta ??= { perps: null, chains: new Map(), ids: new Map() });

export async function deltaPerpTickers(): Promise<Map<string, DeltaTicker>> {
  if (C.perps && Date.now() - C.perps.at < 1500) return C.perps.map;
  const rows = await getJson<DeltaTicker[]>("/v2/tickers?contract_types=perpetual_futures");
  const map = new Map<string, DeltaTicker>();
  for (const r of rows) {
    map.set(r.symbol, r);
    C.ids.set(r.symbol, r.product_id);
  }
  C.perps = { at: Date.now(), map };
  return map;
}

/** All live option tickers for one underlying asset (BTC / ETH), cached 5s. */
export async function deltaOptionTickers(asset: string): Promise<DeltaTicker[]> {
  const key = asset.toUpperCase();
  const hit = C.chains.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.rows;
  const rows = await getJson<DeltaTicker[]>(`/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=${encodeURIComponent(key)}`);
  for (const r of rows) C.ids.set(r.symbol, r.product_id);
  if (C.chains.size > 8) C.chains.clear();
  C.chains.set(key, { at: Date.now(), rows });
  return rows;
}

export async function deltaProductId(symbol: string): Promise<number | null> {
  if (C.ids.has(symbol)) return C.ids.get(symbol)!;
  try {
    const t = await getJson<DeltaTicker>(`/v2/tickers/${encodeURIComponent(symbol)}`);
    if (t?.product_id) {
      C.ids.set(symbol, t.product_id);
      return t.product_id;
    }
  } catch {
    /* unknown symbol */
  }
  return null;
}

/** 1 contract = contract_value coins (BTC 0.001, ETH 0.01 …). Needed for margin & P&L. */
export async function deltaContractValue(symbol: string): Promise<number> {
  try {
    const perps = await deltaPerpTickers();
    const t = perps.get(symbol);
    const v = Number(t?.contract_value);
    if (v && v > 0) return v;
    if (/^[CP]-/.test(symbol)) {
      const p = parseOptionSymbol(symbol);
      if (p) {
        const rows = await deltaOptionTickers(p.asset);
        const o = rows.find((x) => x.symbol === symbol);
        const ov = Number(o?.contract_value);
        if (ov && ov > 0) return ov;
      }
    }
    const single = await getJson<DeltaTicker>(`/v2/tickers/${encodeURIComponent(symbol)}`);
    const sv = Number(single?.contract_value);
    if (sv && sv > 0) return sv;
  } catch {
    /* fallback below */
  }
  return /BTC/.test(symbol) ? 0.001 : 0.01;
}

export function tickerLtp(t: DeltaTicker): number | null {
  return num(t.close) ?? num(t.mark_price);
}

/** symbol like C-BTC-86200-061026 → { type, asset, strike, expiry: yyyy-mm-dd } */
export function parseOptionSymbol(symbol: string): { type: "CE" | "PE"; asset: string; strike: number; expiry: string } | null {
  const m = /^([CP])-([A-Z0-9]+)-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/.exec(symbol);
  if (!m) return null;
  return { type: m[1] === "C" ? "CE" : "PE", asset: m[2], strike: Number(m[3]), expiry: `20${m[6]}-${m[5]}-${m[4]}` };
}

export function optionSymbolFor(asset: string, strike: number, expiry: string, type: "CE" | "PE"): string {
  const [y, mo, d] = expiry.split("-");
  const s = Number.isInteger(strike) ? String(strike) : String(strike);
  return `${type === "CE" ? "C" : "P"}-${asset.toUpperCase()}-${s}-${d}${mo}${y.slice(2)}`;
}

/** App symbol (BTCUSD) → underlying asset (BTC) */
export const assetOf = (symbol: string) => symbol.replace(/USD$/, "");

// ---------- candles ----------
const RES: Record<string, { res: string; sec: number }> = {
  "1m": { res: "1m", sec: 60 },
  "3m": { res: "3m", sec: 180 },
  "5m": { res: "5m", sec: 300 },
  "15m": { res: "15m", sec: 900 },
  "30m": { res: "30m", sec: 1800 },
  "60m": { res: "1h", sec: 3600 },
  "1d": { res: "1d", sec: 86400 },
};

export async function deltaCandles(symbol: string, interval: string, bars = 500): Promise<Candle[] | null> {
  const r = RES[interval] ?? RES["15m"];
  const end = Math.floor(Date.now() / 1000);
  const start = end - r.sec * (bars + 5);
  try {
    const rows = await getJson<{ time: number; open: number; high: number; low: number; close: number; volume: number }[]>(
      `/v2/history/candles?resolution=${r.res}&symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`,
    );
    const out: Candle[] = rows
      .filter((x) => Number.isFinite(x.close) && x.close > 0)
      .map((x) => ({ t: x.time * 1000, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume ?? 0 }))
      .sort((a, b) => a.t - b.t);
    return out.length >= 30 ? out : null;
  } catch {
    return null;
  }
}

// ---------- signed trading API ----------
function sign(secret: string, method: string, timestamp: string, path: string, query: string, body: string): string {
  return createHmac("sha256", secret).update(`${method}${timestamp}${path}${query}${body}`).digest("hex");
}

export async function deltaRequest(opts: { apiKey: string; apiSecret: string; method: "GET" | "POST" | "DELETE"; path: string; query?: string; body?: unknown }): Promise<{ status: number; json: Record<string, unknown> }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const query = opts.query ? (opts.query.startsWith("?") ? opts.query : `?${opts.query}`) : "";
  const body = opts.body != null ? JSON.stringify(opts.body) : "";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${DELTA_BASE}${opts.path}${query}`, {
      method: opts.method,
      signal: ctrl.signal,
      headers: {
        "api-key": opts.apiKey,
        timestamp,
        signature: sign(opts.apiSecret, opts.method, timestamp, opts.path, query, body),
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "algodesk-india",
      },
      body: body || undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}
