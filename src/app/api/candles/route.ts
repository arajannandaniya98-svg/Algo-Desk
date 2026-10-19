import { NextRequest } from "next/server";
import { applyLivePrice, getCandles, INTERVALS, type Interval } from "@/lib/candles";
import { deltaCandles, parseOptionSymbol } from "@/lib/data/delta";
import { deltaFeed, deltaInstrument, deltaKey } from "@/lib/feed/delta";
import { analyse, type Candle, type IndicatorConfig } from "@/lib/indicators";
import { analyseSmc } from "@/lib/smc";
import { bsPrice, ensureSeeded, getInstrument, getQuotes, priceFor } from "@/lib/market";

export const dynamic = "force-dynamic";

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

/** NSE option chart: transform underlying candles into premium candles via Black-Scholes (model). */
function optionCandlesFromUnderlying(under: Candle[], strike: number, expiry: string, type: "CE" | "PE", vol: number): Candle[] {
  const expiryMs = new Date(`${expiry}T15:30:00+05:30`).getTime();
  const out: Candle[] = [];
  for (const c of under) {
    const T = Math.max((expiryMs - c.t) / (365 * 86400000), 0.0005);
    const px = (s: number) => Math.max(0.05, +bsPrice(s, strike, T, 0.07, vol, type).price.toFixed(2));
    const o = px(c.o);
    const cl = px(c.c);
    out.push({ t: c.t, o, h: Math.max(o, cl, px(c.h), px(c.l)), l: Math.min(o, cl, px(c.h), px(c.l)), c: cl, v: c.v });
  }
  return out;
}

/**
 * GET /api/candles?symbol=NIFTY&interval=15m — OHLC + indicator signal + SMC.
 * Also supports OPTION contracts:
 *   • crypto: C-BTC-86000-071026 (real Delta candles)
 *   • NSE:    option=1&underlying=NIFTY&strike=22500&otype=CE&expiry=2026-10-07 (model candles)
 */
export async function GET(req: NextRequest) {
  await ensureSeeded();
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") || "NIFTY").toUpperCase();
  if (!/^[A-Z0-9&_.|-]{1,40}$/.test(symbol)) return Response.json({ error: "Bad symbol" }, { status: 400 });
  const interval = (INTERVALS.find((x) => x.id === sp.get("interval"))?.id ?? "15m") as Interval;
  const indCfg = parseIndicatorConfig(sp);

  // ---------- crypto option contract (real Delta candles) ----------
  const deltaOpt = parseOptionSymbol(symbol);
  if (deltaOpt) {
    const candlesRaw = await deltaCandles(symbol, interval, 500);
    if (!candlesRaw || candlesRaw.length < 10) return Response.json({ error: "No option candle data (contract illiquid/expired?)" }, { status: 404 });
    deltaFeed().lease([deltaInstrument(symbol)], 120_000);
    const live = deltaFeed().tickByKey(deltaKey(symbol));
    const candles = applyLivePrice(candlesRaw, live?.ltp);
    return Response.json({
      symbol,
      name: `${deltaOpt.asset} ${deltaOpt.strike} ${deltaOpt.type} · ${deltaOpt.expiry}`,
      exchange: "DELTA",
      segment: "CRYPTO",
      lotSize: 1,
      isOption: true,
      optionMeta: { underlying: `${deltaOpt.asset}USD`, strike: deltaOpt.strike, type: deltaOpt.type, expiry: deltaOpt.expiry, model: false },
      interval,
      intervals: INTERVALS.map((x) => ({ id: x.id, label: x.label })),
      source: "delta",
      quote: live ? { ltp: live.ltp, changePct: live.changePct ?? 0, source: "live", provider: "delta" } : { ltp: candles[candles.length - 1].c, changePct: 0, source: "delta" },
      candles: candles.slice(-500),
      signal: analyse(candles, indCfg),
      smc: analyseSmc(candles),
      asOf: Date.now(),
    });
  }

  // ---------- NSE/BSE option (model candles from underlying) ----------
  if (sp.get("option") === "1") {
    const underlying = (sp.get("underlying") || "").toUpperCase();
    const strike = Number(sp.get("strike"));
    const otype = sp.get("otype") === "PE" ? "PE" : "CE";
    const expiry = sp.get("expiry") || "";
    const uInst = underlying ? await getInstrument(underlying) : null;
    if (!uInst || !strike || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return Response.json({ error: "underlying, strike, expiry required" }, { status: 400 });
    const uSet = await getCandles(underlying, interval);
    if (!uSet) return Response.json({ error: "No underlying candles" }, { status: 404 });
    const uQuote = (await getQuotes([underlying]))[underlying];
    const uCandles = applyLivePrice(uSet.candles, uQuote?.ltp);
    let candles = optionCandlesFromUnderlying(uCandles, strike, expiry, otype, uInst.volatility);
    // pin the last close to the real option LTP when available (live feed / chain)
    const realLtp = await priceFor({ symbol, underlying, instrumentType: otype, strike, expiry, exchange: uInst.exchange === "DELTA" ? "DELTA" : undefined });
    candles = applyLivePrice(candles, realLtp);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    return Response.json({
      symbol,
      name: `${underlying} ${strike} ${otype} · ${expiry}`,
      exchange: uInst.exchange,
      segment: "OPT",
      lotSize: uInst.lotSize,
      isOption: true,
      optionMeta: { underlying, strike, type: otype, expiry, model: true },
      interval,
      intervals: INTERVALS.map((x) => ({ id: x.id, label: x.label })),
      source: uSet.source === "simulated" ? "simulated" : "model",
      quote: { ltp: last.c, changePct: prev ? +(((last.c - prev.c) / prev.c) * 100).toFixed(2) : 0, source: realLtp != null ? "live" : "model" },
      candles: candles.slice(-500),
      signal: analyse(candles, indCfg),
      smc: analyseSmc(candles),
      asOf: Date.now(),
    });
  }

  const inst = await getInstrument(symbol);
  if (!inst) return Response.json({ error: `${symbol} not found — add it in Stock Finder` }, { status: 404 });
  const set = await getCandles(symbol, interval);
  if (!set) return Response.json({ error: "No candle data" }, { status: 404 });

  const quote = (await getQuotes([symbol]))[symbol];
  const candles = applyLivePrice(set.candles, quote?.ltp);
  const signal = analyse(candles, indCfg);
  const smc = analyseSmc(candles);

  return Response.json({
    symbol,
    name: inst.name,
    exchange: inst.exchange,
    segment: inst.segment,
    lotSize: inst.lotSize,
    isOption: false,
    interval,
    intervals: INTERVALS.map((x) => ({ id: x.id, label: x.label })),
    source: set.source,
    quote,
    candles: candles.slice(-500),
    signal,
    smc,
    asOf: Date.now(),
  });
}
