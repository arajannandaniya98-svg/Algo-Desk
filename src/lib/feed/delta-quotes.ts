import type { Instrument } from "@/db/schema";
import { assetOf, deltaOptionTickers, deltaPerpTickers, optionSymbolFor, tickerLtp, type DeltaTicker } from "@/lib/data/delta";
import type { Quote } from "@/lib/market";
import { deltaFeed, deltaInstrument, deltaKey } from "./delta";

/** Live quote from the Delta WS tick (0-delay) or the 3.5s-cached REST ticker. */
function toQuote(symbol: string, t: DeltaTicker): Quote | null {
  const ltp = tickerLtp(t);
  if (ltp == null) return null;
  const open = Number(t.open) || ltp;
  const change = +(ltp - open).toFixed(4);
  return {
    symbol,
    ltp,
    open,
    high: Number(t.high) || ltp,
    low: Number(t.low) || ltp,
    prevClose: open,
    change,
    changePct: open ? +((change / open) * 100).toFixed(2) : 0,
    volume: Math.round(Number(t.volume) || 0),
    oi: Number(t.oi_contracts) || undefined,
    ts: t.timestamp && t.timestamp > 1e15 ? Math.round(t.timestamp / 1000) : Date.now(),
    source: "live",
    provider: "delta",
    latencyMs: 0,
    delayedMinutes: 0,
  };
}

export async function deltaQuotesFor(rows: Instrument[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  if (!rows.length) return out;
  const feed = deltaFeed();
  // keep these symbols streaming so the next read is a websocket tick
  feed.lease(rows.map((r) => deltaInstrument(r.symbol)), 120_000);
  let perps: Map<string, DeltaTicker> | null = null;
  for (const r of rows) {
    const tick = feed.tickByKey(deltaKey(r.symbol));
    if (tick) {
      out[r.symbol] = {
        symbol: r.symbol,
        ltp: tick.ltp,
        open: tick.open ?? tick.ltp,
        high: tick.high ?? tick.ltp,
        low: tick.low ?? tick.ltp,
        prevClose: tick.prevClose ?? tick.ltp,
        change: tick.change ?? 0,
        changePct: tick.changePct ?? 0,
        volume: tick.volume ?? 0,
        oi: tick.oi,
        ts: tick.exchTs,
        source: "live",
        provider: "delta",
        latencyMs: tick.latencyMs,
        delayedMinutes: 0,
      };
      continue;
    }
    try {
      perps ??= await deltaPerpTickers();
    } catch {
      break; // offline → simulator fallback happens in getQuotes
    }
    const t = perps.get(r.symbol);
    if (t) {
      const q = toQuote(r.symbol, t);
      if (q) out[r.symbol] = q;
    }
  }
  return out;
}

/** LTP for any Delta contract: perp (BTCUSD) or option (C-BTC-86200-061026). */
export async function deltaPriceFor(symbol: string, underlying?: string, instrumentType?: string, strike?: number | null, expiry?: string): Promise<number | null> {
  const feed = deltaFeed();
  const isOption = /^[CP]-/.test(symbol) || ((instrumentType === "CE" || instrumentType === "PE") && strike && expiry);
  const contract = /^[CP]-/.test(symbol) ? symbol : isOption ? optionSymbolFor(assetOf(underlying || symbol), strike!, expiry!, instrumentType as "CE" | "PE") : symbol;
  feed.lease([deltaInstrument(contract)], 120_000);
  const tick = feed.tickByKey(deltaKey(contract));
  if (tick) return tick.ltp;
  try {
    if (isOption) {
      const rows = await deltaOptionTickers(assetOf(underlying || contract.split("-")[1] || ""));
      const t = rows.find((x) => x.symbol === contract);
      return t ? tickerLtp(t) : null;
    }
    const perps = await deltaPerpTickers();
    const t = perps.get(contract);
    return t ? tickerLtp(t) : null;
  } catch {
    return null;
  }
}
