import { db } from "@/db";
import { instruments } from "@/db/schema";
import { ensureSeeded, getQuotes } from "@/lib/market";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export interface MomentumStock {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  sector: string;
  lotSize: number;
  isFno: boolean;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  marketCap: number;
  high52: number;
  low52: number;
  fromHigh52Pct: number;
  momentumScore: number;
  tag: "BREAKOUT" | "TOP_GAINER" | "HIGH_VOLUME" | "52W_HIGH" | "MOMENTUM_LEADER";
  catalyst: string;
  source: string;
}

/**
 * GET /api/momentum — Real-time scanner for India's Top Momentum Stocks
 * Evaluates Indian equities and F&O leaders based on:
 * 1. 24h Change % (Price velocity)
 * 2. High Relative Volume
 * 3. Proximity to 52-Week High (< 5% from 52W High = Breakout zone)
 * 4. F&O liquidity & Market Cap
 */
export async function GET(req: NextRequest) {
  await ensureSeeded();
  const category = req.nextUrl.searchParams.get("cat") || "ALL"; // ALL | FNO | GAINERS | BREAKOUTS | 52W

  // Fetch all Indian equities & F&O stocks
  const rows = await db
    .select()
    .from(instruments)
    .where(sql`${instruments.exchange} IN ('NSE', 'BSE') AND ${instruments.segment} IN ('EQ', 'INDEX')`)
    .limit(300);

  const symbols = rows.map((r) => r.symbol);
  const quotes = await getQuotes(symbols);

  const scored: MomentumStock[] = [];

  for (const r of rows) {
    const q = quotes[r.symbol];
    if (!q || !Number.isFinite(q.ltp) || q.ltp <= 0) continue;

    const ltp = q.ltp;
    const changePct = q.changePct ?? (q.prevClose ? +(((ltp - q.prevClose) / q.prevClose) * 100).toFixed(2) : 0);
    const high52 = r.high52 || ltp * 1.25;
    const fromHigh52Pct = high52 > 0 ? +(((ltp - high52) / high52) * 100).toFixed(1) : -10;

    // Relative volume proxy based on lotSize and marketcap
    const estimatedAvgVol = Math.max(50000, (r.marketCap || 10000) * 15);
    const volMultiple = q.volume > 0 ? +(q.volume / estimatedAvgVol).toFixed(2) : 1;

    // Momentum scoring algorithm (0 to 100):
    // 40% from Price Change %, 30% from 52W High proximity, 20% from Volume multiple, 10% from F&O leverage
    let score = 50;
    score += Math.min(30, changePct * 6); // +1% move adds ~6 pts
    if (fromHigh52Pct > -5) score += 20; // within 5% of 52W high
    else if (fromHigh52Pct > -10) score += 10;
    if (volMultiple > 2) score += 15;
    else if (volMultiple > 1.2) score += 8;
    if (r.isFno) score += 10;

    // Classify catalyst tag
    let tag: MomentumStock["tag"] = "MOMENTUM_LEADER";
    let catalyst = "Strong Trend Continuity";

    if (fromHigh52Pct >= -2) {
      tag = "52W_HIGH";
      catalyst = "Near 52-Week High Breakout Zone";
    } else if (changePct >= 2.5) {
      tag = "TOP_GAINER";
      catalyst = `Fast Velocity (+${changePct.toFixed(1)}% Day Gain)`;
    } else if (volMultiple >= 2) {
      tag = "HIGH_VOLUME";
      catalyst = `Heavy Volume Surge (${volMultiple}× Normal)`;
    } else if (changePct > 0.8 && r.isFno) {
      tag = "BREAKOUT";
      catalyst = "Bullish F&O Momentum Setup";
    }

    scored.push({
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange,
      segment: r.segment,
      sector: r.sector,
      lotSize: r.lotSize,
      isFno: r.isFno,
      ltp,
      open: q.open ?? ltp,
      high: q.high ?? ltp,
      low: q.low ?? ltp,
      prevClose: q.prevClose ?? ltp,
      change: q.change ?? 0,
      changePct,
      volume: q.volume || 0,
      marketCap: r.marketCap,
      high52: r.high52,
      low52: r.low52,
      fromHigh52Pct,
      momentumScore: Math.max(10, Math.min(99, Math.round(score))),
      tag,
      catalyst,
      source: q.source ?? "simulated",
    });
  }

  // Filter based on category
  let filtered = scored;
  if (category === "FNO") {
    filtered = scored.filter((s) => s.isFno);
  } else if (category === "GAINERS") {
    filtered = scored.filter((s) => s.changePct > 0);
  } else if (category === "BREAKOUTS") {
    filtered = scored.filter((s) => s.fromHigh52Pct >= -6);
  } else if (category === "52W") {
    filtered = scored.filter((s) => s.tag === "52W_HIGH");
  }

  // Sort by Momentum Score descending
  filtered.sort((a, b) => b.momentumScore - a.momentumScore || b.changePct - a.changePct);

  // Return top picks
  return Response.json({
    category,
    total: filtered.length,
    topMomentum: filtered.slice(0, 30),
    asOf: Date.now(),
  });
}
