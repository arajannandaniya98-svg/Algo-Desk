import { NextRequest } from "next/server";
import { applyLivePrice, getCandles } from "@/lib/candles";
import { assetOf, deltaOptionTickers, parseOptionSymbol } from "@/lib/data/delta";
import { labelExpiries } from "@/lib/expiry-labels";
import { liveProvider } from "@/lib/feed/live";
import { realExpiries } from "@/lib/feed/tokens";
import { analyse } from "@/lib/indicators";
import { buildOptionChain, ensureSeeded, getExpiries, getInstrument, getQuoteForInstrument } from "@/lib/market";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/snapshot?symbol=NIFTY — everything about one instrument:
 * quote + ranges, indicator signal, levels, expiries (This Week / Next Week / Monthly)
 * and option metrics (PCR, Max Pain, ATM IV / straddle) for F&O underlyings.
 */
export async function GET(req: NextRequest) {
  await ensureSeeded();
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();
  if (!/^[A-Z0-9&_.-]{1,32}$/.test(symbol)) return Response.json({ error: "Bad symbol" }, { status: 400 });
  const inst = await getInstrument(symbol);
  if (!inst) return Response.json({ error: `${symbol} not found — add it in Stock Finder` }, { status: 404 });

  const quote = await getQuoteForInstrument(inst);
  const set = await getCandles(symbol, "15m");
  const sig = set ? analyse(applyLivePrice(set.candles, quote.ltp)) : null;

  const pct = (v: number, lo: number, hi: number) => (hi > lo ? +(((v - lo) / (hi - lo)) * 100).toFixed(1) : null);

  // ---------- expiries with labels ----------
  const isCrypto = inst.exchange === "DELTA";
  let expiries: string[] = [];
  let options: {
    expiry: string;
    atm: number;
    pcr: number | null;
    maxPain: number | null;
    atmIv: number | null;
    straddle: number | null;
    ceOi: number;
    peOi: number;
    source: "live" | "model";
  } | null = null;

  if (inst.isFno || isCrypto) {
    try {
      if (isCrypto) {
        const rows = await deltaOptionTickers(assetOf(symbol));
        const exps = new Set<string>();
        for (const r of rows) {
          const p = parseOptionSymbol(r.symbol);
          if (p) exps.add(p.expiry);
        }
        expiries = [...exps].sort().slice(0, 10);
        if (expiries[0]) {
          const near = rows.filter((r) => parseOptionSymbol(r.symbol)?.expiry === expiries[0]);
          let ceOi = 0;
          let peOi = 0;
          let atm = 0;
          let best = Infinity;
          for (const r of near) {
            const p = parseOptionSymbol(r.symbol)!;
            const oi = Number(r.oi_contracts) || 0;
            if (p.type === "CE") ceOi += oi;
            else peOi += oi;
            if (Math.abs(p.strike - quote.ltp) < best) {
              best = Math.abs(p.strike - quote.ltp);
              atm = p.strike;
            }
          }
          const atmCe = near.find((r) => r.symbol.startsWith("C-") && parseOptionSymbol(r.symbol)?.strike === atm);
          const atmPe = near.find((r) => r.symbol.startsWith("P-") && parseOptionSymbol(r.symbol)?.strike === atm);
          const ceLtp = Number(atmCe?.close ?? atmCe?.mark_price) || 0;
          const peLtp = Number(atmPe?.close ?? atmPe?.mark_price) || 0;
          options = {
            expiry: expiries[0],
            atm,
            pcr: ceOi ? +(peOi / ceOi).toFixed(2) : null,
            maxPain: null,
            atmIv: atmCe?.quotes?.mark_iv ? +(Number(atmCe.quotes.mark_iv) * 100).toFixed(1) : null,
            straddle: ceLtp && peLtp ? +(ceLtp + peLtp).toFixed(2) : null,
            ceOi,
            peOi,
            source: "live",
          };
        }
      } else {
        const provider = liveProvider();
        const exchange = symbol === "SENSEX" || symbol === "BANKEX" ? "BSE" : "NSE";
        if (provider) expiries = await realExpiries(provider, symbol, exchange);
        if (!expiries.length) expiries = getExpiries(symbol);
        if (expiries[0]) {
          const chain = buildOptionChain(symbol, quote.ltp, expiries[0], inst.volatility, 10);
          const ceOi = chain.reduce((a, r) => a + r.ce.oi, 0);
          const peOi = chain.reduce((a, r) => a + r.pe.oi, 0);
          const atmRow = chain.reduce((b, r) => (Math.abs(r.strike - quote.ltp) < Math.abs(b.strike - quote.ltp) ? r : b), chain[0]);
          const maxPain =
            chain
              .map((row) => ({ k: row.strike, pain: chain.reduce((p, r) => p + Math.max(row.strike - r.strike, 0) * r.ce.oi + Math.max(r.strike - row.strike, 0) * r.pe.oi, 0) }))
              .sort((a, b) => a.pain - b.pain)[0]?.k ?? null;
          options = {
            expiry: expiries[0],
            atm: atmRow.strike,
            pcr: ceOi ? +(peOi / ceOi).toFixed(2) : null,
            maxPain,
            atmIv: atmRow.ce.iv || null,
            straddle: +(atmRow.ce.ltp + atmRow.pe.ltp).toFixed(2),
            ceOi,
            peOi,
            source: "model",
          };
        }
      }
    } catch {
      /* snapshot stays partial */
    }
  }

  return Response.json({
    symbol,
    name: inst.name,
    exchange: inst.exchange,
    segment: inst.segment,
    sector: inst.sector,
    lotSize: inst.lotSize,
    isFno: inst.isFno || isCrypto,
    currency: isCrypto ? "USD" : "INR",
    quote,
    ranges: {
      dayPct: pct(quote.ltp, quote.low, quote.high),
      high52: inst.high52,
      low52: inst.low52,
      yearPct: pct(quote.ltp, inst.low52, inst.high52),
      fromHigh52: inst.high52 ? +(((quote.ltp - inst.high52) / inst.high52) * 100).toFixed(1) : null,
      fromLow52: inst.low52 ? +(((quote.ltp - inst.low52) / inst.low52) * 100).toFixed(1) : null,
    },
    fundamentals: { marketCap: inst.marketCap, pe: inst.pe },
    signal: sig
      ? { signal: sig.signal, score: sig.score, strength: sig.strength, trend: sig.trend, buy: sig.buy, sell: sig.sell, hold: sig.hold, levels: sig.levels, candleSource: set?.source }
      : null,
    expiries: labelExpiries(expiries),
    options,
    asOf: Date.now(),
  });
}
