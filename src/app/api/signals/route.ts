import { NextRequest } from "next/server";
import { applyLivePrice, getCandles, INTERVALS, type Interval } from "@/lib/candles";
import { analyse, type SignalResult, type IndicatorConfig } from "@/lib/indicators";
import { ensureSeeded, getQuotes } from "@/lib/market";

function parseIndicatorConfig(sp: URLSearchParams): Partial<IndicatorConfig> {
  const p = (k: string) => {
    const v = Number(sp.get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return {
    supertrendPeriod: p("ind_st_p"),
    supertrendMult: p("ind_st_m"),
    emaFast: p("ind_ema_f"),
    emaSlow: p("ind_ema_s"),
    macdFast: p("ind_macd_f"),
    macdSlow: p("ind_macd_s"),
    macdSignal: p("ind_macd_sig"),
    rsiPeriod: p("ind_rsi_p"),
    rsiOverbought: p("ind_rsi_ob"),
    rsiOversold: p("ind_rsi_os"),
    adxPeriod: p("ind_adx_p"),
    adxThreshold: p("ind_adx_th"),
    bollingerPeriod: p("ind_bb_p"),
    bollingerMult: p("ind_bb_m"),
    stochPeriod: p("ind_stoch_p"),
    stochSmooth: p("ind_stoch_s"),
    ema50Period: p("ind_ema50_p"),
    volumePeriod: p("ind_vol_p"),
  };
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export interface SymbolSignal extends SignalResult {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  lotSize: number;
  interval: Interval;
  ltp: number;
  dayChangePct: number;
  priceSource: string;
  candleSource: "yahoo" | "delta" | "simulated";
  spark: number[];
  asOf: number;
}

const DEFAULTS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "BTCUSD", "ETHUSD"];

/** GET /api/signals?symbols=NIFTY,RELIANCE&interval=15m — BUY / SELL / HOLD per symbol */
export async function GET(req: NextRequest) {
  await ensureSeeded();
  const sp = req.nextUrl.searchParams;
  const interval = (INTERVALS.find((x) => x.id === sp.get("interval"))?.id ?? "15m") as Interval;
  const indCfg = parseIndicatorConfig(sp);
  const symbols = [
    ...new Set(
      (sp.get("symbols") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9&_.-]{1,32}$/.test(s)),
    ),
  ].slice(0, 40);
  const list = symbols.length ? symbols : DEFAULTS;

  const quotes = await getQuotes(list);
  const results: SymbolSignal[] = [];
  const failed: string[] = [];

  // small batches keep Yahoo happy and the response fast
  for (let i = 0; i < list.length; i += 6) {
    const batch = await Promise.all(
      list.slice(i, i + 6).map(async (symbol) => {
        try {
          const set = await getCandles(symbol, interval);
          if (!set) return null;
          const q = quotes[symbol];
          const candles = applyLivePrice(set.candles, q?.ltp);
          const a = analyse(candles, indCfg);
          if (!a) return null;
          const out: SymbolSignal = {
            ...a,
            symbol,
            name: symbol,
            exchange: "",
            segment: "",
            lotSize: 1,
            interval,
            ltp: q?.ltp ?? a.close,
            dayChangePct: q?.changePct ?? a.changePct,
            priceSource: q?.source ?? "simulated",
            candleSource: set.source,
            spark: candles.slice(-48).map((c) => c.c),
            asOf: Date.now(),
          };
          return out;
        } catch {
          return null;
        }
      }),
    );
    batch.forEach((r, k) => (r ? results.push(r) : failed.push(list[i + k])));
  }

  // enrich with instrument meta
  const { db } = await import("@/db");
  const { instruments } = await import("@/db/schema");
  const { inArray } = await import("drizzle-orm");
  if (results.length) {
    const rows = await db.select().from(instruments).where(inArray(instruments.symbol, results.map((r) => r.symbol)));
    const meta = new Map(rows.map((r) => [r.symbol, r]));
    for (const r of results) {
      const m = meta.get(r.symbol);
      if (m) {
        r.name = m.name;
        r.exchange = m.exchange;
        r.segment = m.segment;
        r.lotSize = m.lotSize;
      }
    }
  }

  const order = { BUY: 0, SELL: 1, HOLD: 2 } as const;
  results.sort((a, b) => order[a.signal] - order[b.signal] || Math.abs(b.score) - Math.abs(a.score));

  return Response.json({
    interval,
    intervals: INTERVALS,
    count: results.length,
    failed,
    summary: {
      buy: results.filter((r) => r.signal === "BUY").length,
      sell: results.filter((r) => r.signal === "SELL").length,
      hold: results.filter((r) => r.signal === "HOLD").length,
    },
    items: results,
    asOf: Date.now(),
  });
}
