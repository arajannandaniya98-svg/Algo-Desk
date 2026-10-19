import type { Instrument } from "@/db/schema";
import type { Quote } from "@/lib/market";
import { feedHub } from "./hub";
import { resolveFeedInstrument, type ResolveQuery } from "./tokens";
import type { LiveTick } from "./types";

/** Real broker feed currently connected? (demo ticks never replace real prices) */
export function liveProvider(): "dhan" | "angelone" | null {
  const h = feedHub();
  return h.isLive() ? (h.provider as "dhan" | "angelone") : null;
}

export function tickToQuote(t: LiveTick, symbol: string): Quote {
  return {
    symbol,
    ltp: t.ltp,
    open: t.open ?? t.ltp,
    high: t.high ?? t.ltp,
    low: t.low ?? t.ltp,
    prevClose: t.prevClose ?? t.ltp,
    change: t.change ?? 0,
    changePct: t.changePct ?? 0,
    volume: t.volume ?? 0,
    oi: t.oi,
    ts: t.exchTs,
    source: "live",
    provider: t.provider,
    latencyMs: t.latencyMs,
    delayedMinutes: 0,
  };
}

/** Latest broker tick for an instrument; also (re)subscribes it so the next read is real-time. */
export async function liveTickFor(q: ResolveQuery, ttlMs = 120_000): Promise<LiveTick | null> {
  const provider = liveProvider();
  if (!provider) return null;
  const inst = await resolveFeedInstrument(provider, q);
  if (!inst) return null;
  const hub = feedHub();
  hub.lease([inst], ttlMs);
  return hub.tickByKey(inst.key) ?? null;
}

export async function liveQuotesFor(rows: Instrument[]): Promise<Record<string, Quote>> {
  if (!liveProvider() || !rows.length) return {};
  const out: Record<string, Quote> = {};
  await Promise.all(
    rows.map(async (r) => {
      const type = r.segment === "INDEX" ? "INDEX" : r.segment === "EQ" ? "EQ" : "FUT";
      const t = await liveTickFor({ symbol: r.symbol, underlying: r.symbol, instrumentType: type, exchange: r.exchange });
      if (t) out[r.symbol] = tickToQuote(t, r.symbol);
    }),
  );
  return out;
}
