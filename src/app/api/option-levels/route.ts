import { NextRequest } from "next/server";
import { applyLivePrice, getCandles } from "@/lib/candles";
import { analyse } from "@/lib/indicators";
import { ensureSeeded, getInstrument, getQuotes } from "@/lib/market";

export const dynamic = "force-dynamic";

/**
 * GET /api/option-levels?underlying=NIFTY&premium=150&side=BUY&type=CE&strike=24000&spot=24100
 * Automated SL / Target / Support / Resistance for an option trade:
 *  - Underlying 15m candles → ATR, swing support/resistance, combined signal
 *  - Premium SL/Target via delta-approximated underlying moves (capped % rules)
 */
export async function GET(req: NextRequest) {
  await ensureSeeded();
  const sp = req.nextUrl.searchParams;
  const underlying = (sp.get("underlying") || "").toUpperCase();
  const premium = Number(sp.get("premium")) || 0;
  const side = sp.get("side") === "SELL" ? "SELL" : "BUY";
  const type = sp.get("type") === "PE" ? "PE" : "CE";
  const strike = Number(sp.get("strike")) || 0;
  const inst = underlying ? await getInstrument(underlying) : null;
  if (!inst) return Response.json({ error: "Unknown underlying" }, { status: 404 });

  const quote = (await getQuotes([underlying]))[underlying];
  const spot = Number(sp.get("spot")) || quote?.ltp || inst.basePrice;
  const set = await getCandles(underlying, "15m");
  const a = set ? analyse(applyLivePrice(set.candles, spot)) : null;

  const atr = a?.levels.atr ?? spot * 0.004;
  const support = a?.levels.support ?? +(spot * 0.99).toFixed(2);
  const resistance = a?.levels.resistance ?? +(spot * 1.01).toFixed(2);

  // delta estimate from moneyness (ATM ≈ 0.5)
  const dist = strike && spot ? (type === "CE" ? spot - strike : strike - spot) / (atr * 6 || 1) : 0;
  const delta = Math.min(0.95, Math.max(0.05, 0.5 + 0.35 * Math.tanh(dist)));

  // underlying move of 1.5×ATR against / 3×ATR in favour → premium move via delta
  const slMovePrem = 1.5 * atr * delta;
  const tgMovePrem = 3 * atr * delta;
  let stopLoss: number;
  let target: number;
  if (side === "BUY") {
    // long option: SL = premium - move (min 25%, max 50% premium loss), Target = premium + move (min 40% gain)
    stopLoss = Math.max(premium - slMovePrem, premium * 0.5);
    stopLoss = Math.min(stopLoss, premium * 0.75);
    target = Math.max(premium + tgMovePrem, premium * 1.4);
  } else {
    // short option: SL above (30-60% of premium), target = decay toward 40% of premium
    stopLoss = Math.min(premium + slMovePrem, premium * 1.6);
    stopLoss = Math.max(stopLoss, premium * 1.3);
    target = Math.max(premium - tgMovePrem, premium * 0.4);
  }
  const r2 = (n: number) => Math.max(0.05, +n.toFixed(2));
  stopLoss = r2(stopLoss);
  target = r2(target);
  const risk = Math.abs(premium - stopLoss);

  return Response.json({
    underlying,
    spot,
    premium,
    side,
    type,
    strike,
    atr: +atr.toFixed(2),
    deltaEst: +delta.toFixed(2),
    stopLoss,
    target,
    support,
    resistance,
    riskReward: risk ? +(Math.abs(target - premium) / risk).toFixed(2) : 0,
    signal: a ? { signal: a.signal, score: a.score, trend: a.trend } : null,
    basis: `ATR(15m) ${atr.toFixed(2)} × delta ~${delta.toFixed(2)} · SL 1.5×ATR · Target 3×ATR · capped ${side === "BUY" ? "25-50% premium" : "30-60% premium"}`,
  });
}
