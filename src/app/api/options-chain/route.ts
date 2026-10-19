import { db } from "@/db";
import { instruments } from "@/db/schema";
import { feedHub } from "@/lib/feed/hub";
import { liveProvider } from "@/lib/feed/live";
import { chainInstruments, realExpiries } from "@/lib/feed/tokens";
import type { FeedInstrument } from "@/lib/feed/types";
import { bsPrice, buildOptionChain, ensureSeeded, getExpiries, getInstrument, getQuoteForInstrument, impliedVol, strikeStep } from "@/lib/market";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { assetOf, deltaOptionTickers, parseOptionSymbol, tickerLtp } from "@/lib/data/delta";
import { deltaFeed, deltaInstrument, deltaKey } from "@/lib/feed/delta";

export const dynamic = "force-dynamic";

/**
 * GET /api/options-chain?underlying=NIFTY&expiry=2026-10-06&strikes=12
 * With a live broker feed + synced scrip master: real expiries, real strikes,
 * live premiums / OI / bid-ask and IV + Greeks implied from the live premium.
 * Otherwise: Black-Scholes model on the best available spot.
 */
export async function GET(req: NextRequest) {
  await ensureSeeded();
  const sp = req.nextUrl.searchParams;
  const underlying = (sp.get("underlying") || "NIFTY").toUpperCase();
  const strikes = Math.min(Math.max(Number(sp.get("strikes") || 12), 2), 40);

  const inst = await getInstrument(underlying);
  if (!inst) return Response.json({ error: "Unknown underlying" }, { status: 404 });

  const underlyings = await db
    .select({ symbol: instruments.symbol, name: instruments.name, segment: instruments.segment, lotSize: instruments.lotSize })
    .from(instruments)
    .where(eq(instruments.isFno, true))
    .orderBy(instruments.segment, instruments.symbol);

  // ---------- crypto: real Delta Exchange option chain (live premiums, OI, Greeks, IV) ----------
  if (inst.exchange === "DELTA") {
    const quote = await getQuoteForInstrument(inst);
    const asset = assetOf(underlying);
    let rows: Awaited<ReturnType<typeof deltaOptionTickers>> = [];
    try {
      rows = await deltaOptionTickers(asset);
    } catch {
      /* offline */
    }
    const byExpiry = new Map<string, Map<number, { CE?: (typeof rows)[number]; PE?: (typeof rows)[number] }>>();
    for (const r of rows) {
      const p = parseOptionSymbol(r.symbol);
      if (!p) continue;
      const em = byExpiry.get(p.expiry) ?? new Map();
      const sm = em.get(p.strike) ?? {};
      sm[p.type] = r;
      em.set(p.strike, sm);
      byExpiry.set(p.expiry, em);
    }
    const expiries = [...byExpiry.keys()].sort();
    const requested = sp.get("expiry");
    const expiry = requested && expiries.includes(requested) ? requested : expiries[0] ?? "";
    const em = byExpiry.get(expiry) ?? new Map();
    const allStrikes = [...em.keys()].sort((a, b) => a - b);
    let atmIdx = 0;
    allStrikes.forEach((k, i) => {
      if (Math.abs(k - quote.ltp) < Math.abs(allStrikes[atmIdx] - quote.ltp)) atmIdx = i;
    });
    const shown = allStrikes.slice(Math.max(0, atmIdx - strikes), atmIdx + strikes + 1);
    const feed = deltaFeed();
    const lease: ReturnType<typeof deltaInstrument>[] = [deltaInstrument(underlying)];
    const mkLeg = (t?: (typeof rows)[number]) => {
      if (!t) return { ltp: 0, change: 0, changePct: 0, oi: 0, oiChange: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0, bid: 0, ask: 0, live: false };
      lease.push(deltaInstrument(t.symbol));
      const live = feed.tickByKey(deltaKey(t.symbol));
      const ltp = live?.ltp ?? tickerLtp(t) ?? 0;
      const open = Number(t.open) || ltp;
      return {
        ltp,
        change: +(ltp - open).toFixed(2),
        changePct: open ? +(((ltp - open) / open) * 100).toFixed(2) : 0,
        oi: live?.oi ?? Math.round(Number(t.oi_contracts) || 0),
        oiChange: 0,
        volume: live?.volume ?? Math.round(Number(t.volume) || 0),
        iv: +((Number(t.quotes?.mark_iv) || 0) * 100).toFixed(2),
        delta: +(Number(t.greeks?.delta) || 0).toFixed(3),
        gamma: +(Number(t.greeks?.gamma) || 0).toFixed(5),
        theta: +(Number(t.greeks?.theta) || 0).toFixed(2),
        vega: +(Number(t.greeks?.vega) || 0).toFixed(2),
        bid: live?.bid ?? (Number(t.quotes?.best_bid) || 0),
        ask: live?.ask ?? (Number(t.quotes?.best_ask) || 0),
        token: String(t.product_id),
        key: deltaKey(t.symbol),
        tradingSymbol: t.symbol,
        live: true,
      };
    };
    const chain = shown.map((k) => {
      const pair = em.get(k) ?? {};
      return { strike: k, ce: mkLeg(pair.CE), pe: mkLeg(pair.PE) };
    });
    feed.lease(lease, 60_000);
    const totalCeOi = chain.reduce((a, r) => a + r.ce.oi, 0);
    const totalPeOi = chain.reduce((a, r) => a + r.pe.oi, 0);
    const maxPain = chain
      .map((row) => ({ strike: row.strike, pain: chain.reduce((p, r) => p + Math.max(row.strike - r.strike, 0) * r.ce.oi + Math.max(r.strike - row.strike, 0) * r.pe.oi, 0) }))
      .sort((a, b) => a.pain - b.pain)[0]?.strike ?? 0;
    const step = shown.length > 1 ? Math.min(...shown.slice(1).map((k, i) => +(k - shown[i]).toFixed(2))) : 100;
    return Response.json({
      underlying,
      name: inst.name,
      lotSize: 1,
      spot: quote,
      expiry,
      expiries,
      step,
      atm: allStrikes[atmIdx] ?? 0,
      pcr: totalCeOi ? +(totalPeOi / totalCeOi).toFixed(2) : 0,
      maxPain,
      totalCeOi,
      totalPeOi,
      chain,
      underlyings,
      live: rows.length ? { provider: "delta", liveLegs: chain.length * 2, totalLegs: chain.length * 2, realContracts: true } : null,
      currency: "USD",
    });
  }

  const exchange = underlying === "SENSEX" || underlying === "BANKEX" ? "BSE" : "NSE";
  const quote = await getQuoteForInstrument(inst);
  const provider = liveProvider();

  let expiries = getExpiries(underlying);
  if (provider) {
    const real = await realExpiries(provider, underlying, exchange);
    if (real.length) expiries = real;
  }
  const requested = sp.get("expiry");
  const expiry = requested && expiries.includes(requested) ? requested : expiries[0];

  let lotSize = inst.lotSize;
  let liveMap: Map<number, { CE?: FeedInstrument; PE?: FeedInstrument }> | null = null;
  let strikeList: number[] | undefined;
  if (provider) {
    const c = await chainInstruments(provider, underlying, expiry, exchange);
    if (c.map.size) {
      liveMap = c.map;
      lotSize = c.lotSize || lotSize;
      const all = [...c.map.keys()].sort((a, b) => a - b);
      let atmIdx = 0;
      all.forEach((k, i) => {
        if (Math.abs(k - quote.ltp) < Math.abs(all[atmIdx] - quote.ltp)) atmIdx = i;
      });
      strikeList = all.slice(Math.max(0, atmIdx - strikes), atmIdx + strikes + 1);
    }
  }

  const chain = buildOptionChain(underlying, quote.ltp, expiry, inst.volatility, strikes, strikeList);
  let liveLegs = 0;
  if (liveMap) {
    const hub = feedHub();
    const lease: FeedInstrument[] = [];
    const T = Math.max((new Date(`${expiry}T15:30:00+05:30`).getTime() - Date.now()) / (365 * 86400000), 0.0005);
    for (const row of chain) {
      const pair = liveMap.get(row.strike);
      if (!pair) continue;
      for (const type of ["CE", "PE"] as const) {
        const fi = pair[type];
        if (!fi) continue;
        lease.push(fi);
        const leg = type === "CE" ? row.ce : row.pe;
        leg.token = fi.token;
        leg.key = fi.key;
        leg.tradingSymbol = fi.tradingSymbol;
        const t = hub.tickByKey(fi.key);
        if (!t) continue;
        liveLegs++;
        leg.live = true;
        leg.ltp = t.ltp;
        if (t.oi != null) leg.oi = t.oi;
        leg.oiChange = t.oi != null && t.prevOi != null ? t.oi - t.prevOi : 0;
        if (t.volume != null) leg.volume = t.volume;
        if (t.change != null) leg.change = t.change;
        if (t.changePct != null) leg.changePct = t.changePct;
        if (t.bid) leg.bid = t.bid;
        if (t.ask) leg.ask = t.ask;
        const iv = impliedVol(t.ltp, quote.ltp, row.strike, T, 0.07, type);
        if (iv) {
          const gk = bsPrice(quote.ltp, row.strike, T, 0.07, iv, type);
          leg.iv = +(iv * 100).toFixed(2);
          leg.delta = +gk.delta.toFixed(3);
          leg.gamma = +gk.gamma.toFixed(5);
          leg.theta = +gk.theta.toFixed(2);
          leg.vega = +gk.vega.toFixed(2);
        }
      }
    }
    hub.lease(lease, 60_000);
  }

  const totalCeOi = chain.reduce((a, r) => a + r.ce.oi, 0);
  const totalPeOi = chain.reduce((a, r) => a + r.pe.oi, 0);
  const maxPain = chain
    .map((row) => {
      let pain = 0;
      for (const r of chain) pain += Math.max(row.strike - r.strike, 0) * r.ce.oi + Math.max(r.strike - row.strike, 0) * r.pe.oi;
      return { strike: row.strike, pain };
    })
    .sort((a, b) => a.pain - b.pain)[0]?.strike;

  const step = strikeList && strikeList.length > 1 ? Math.min(...strikeList.slice(1).map((k, i) => +(k - strikeList![i]).toFixed(2))) : strikeStep(quote.ltp);
  const atm = chain.reduce((best, r) => (Math.abs(r.strike - quote.ltp) < Math.abs(best - quote.ltp) ? r.strike : best), chain[0]?.strike ?? 0);

  return Response.json({
    underlying,
    name: inst.name,
    lotSize,
    spot: quote,
    expiry,
    expiries,
    step,
    atm,
    pcr: totalCeOi ? +(totalPeOi / totalCeOi).toFixed(2) : 0,
    maxPain,
    totalCeOi,
    totalPeOi,
    chain,
    underlyings,
    live: provider ? { provider, liveLegs, totalLegs: chain.length * 2, realContracts: !!liveMap } : null,
  });
}
