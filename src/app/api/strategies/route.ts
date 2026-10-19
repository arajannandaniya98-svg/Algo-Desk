import { db } from "@/db";
import { brokers, setups, strategies, type Setup } from "@/db/schema";
import { capitalSnapshot } from "@/lib/capital";
import { computePayoff, legProtective, templateById, TEMPLATES, type LegSpec } from "@/lib/strategies";
import { buildOptionChain, ensureSeeded, getExpiries, getInstrument, getQuoteForInstrument, strikeStep } from "@/lib/market";
import { currentPrice } from "@/lib/engine";
import { desc, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/strategies — list saved strategies with live leg P&L */
export async function GET() {
  const rows = await db.select().from(strategies).orderBy(desc(strategies.updatedAt));
  const allSetups = await db.select().from(setups);
  const out = await Promise.all(
    rows.map(async (st) => {
      const legs = allSetups.filter((s) => s.strategyId === st.id).sort((a, b) => a.legIndex - b.legIndex);
      const priced = await Promise.all(
        legs.map(async (l) => {
          const ltp = await currentPrice(l);
          const pnl = l.status === "ENTERED" && ltp != null && l.entryFilledPrice != null ? (ltp - l.entryFilledPrice) * (l.side === "BUY" ? 1 : -1) * l.quantity : l.status === "EXITED" ? l.pnl : 0;
          return { ...l, ltp, pnl: +pnl.toFixed(2) };
        }),
      );
      const combined = +priced.reduce((a, l) => a + l.pnl, 0).toFixed(2);
      const status = priced.every((l) => l.status === "EXITED") ? "EXITED" : priced.some((l) => l.status === "ENTERED") ? "ENTERED" : priced.some((l) => l.status === "ACTIVE") ? "ACTIVE" : "DRAFT";
      return { ...st, status, legs: priced, combinedPnl: combined, openLegs: priced.filter((l) => l.status === "ENTERED").length };
    }),
  );
  return Response.json({ items: out, templates: TEMPLATES });
}

/**
 * POST /api/strategies
 *  { action: "preview" } → payoff preview (nothing saved)
 *  { action: "create" }   → create strategy + one setup per leg
 */
export async function POST(req: NextRequest) {
  await ensureSeeded();
  const b = await req.json();
  const action = b.action ?? "create";
  const underlying = String(b.underlying || "NIFTY").toUpperCase();
  const templateId = String(b.template || "CUSTOM");
  const lots = Math.max(1, Math.floor(Number(b.lots) || 1));

  const inst = await getInstrument(underlying);
  if (!inst) return Response.json({ error: `Unknown underlying ${underlying}` }, { status: 404 });
  const quote = await getQuoteForInstrument(inst);
  const expiries = getExpiries(underlying);
  const expiry = String(b.expiry || expiries[0]);
  const step = strikeStep(quote.ltp);
  const atm = Math.round(quote.ltp / step) * step;
  const chain = buildOptionChain(underlying, quote.ltp, expiry, inst.volatility, 30);

  const legs: LegSpec[] = Array.isArray(b.legs) && b.legs.length ? b.legs : templateById(templateId).legs;
  const payoff = computePayoff({ spot: quote.ltp, atm, step, lotSize: inst.lotSize, lots, chain, legs });
  const oneLot = computePayoff({ spot: quote.ltp, atm, step, lotSize: inst.lotSize, lots: 1, chain, legs });

  if (action === "preview") {
    const snap = await capitalSnapshot();
    return Response.json({
      underlying,
      name: inst.name,
      spot: quote,
      marginPerLot: oneLot.marginRequired,
      perLotPremium: oneLot.netCashflow,
      atm,
      step,
      expiry,
      expiries,
      lotSize: inst.lotSize,
      strikes: chain.map((c) => c.strike),
      payoff,
      capital: { free: snap.freeMargin, used: snap.usedMargin, total: snap.capital, affordable: payoff.marginRequired <= snap.freeMargin, maxLots: Math.floor(snap.freeMargin / Math.max(oneLot.marginRequired, 1)) },
      template: templateById(templateId),
    });
  }

  // ---- create ----
  const name = String(b.name || `${templateById(templateId).name} ${underlying}`).slice(0, 120);
  const snap = await capitalSnapshot();
  if (snap.settings.enforceCapital && payoff.marginRequired > snap.freeMargin) {
    return Response.json(
      { error: `Margin ₹${payoff.marginRequired.toFixed(0)} exceeds free capital ₹${snap.freeMargin.toFixed(0)}. Reduce lots.` },
      { status: 400 },
    );
  }

  const { resolveAutoBroker } = await import("@/lib/brokers");
  const isCryptoStrat = underlying.endsWith("USD");
  const autoBroker = await resolveAutoBroker({
    exchange: isCryptoStrat ? "DELTA" : "NSE",
    symbol: underlying,
    segment: isCryptoStrat ? "CRYPTO" : "OPT",
    preferredBrokerId: b.brokerId ? Number(b.brokerId) : null,
  });
  const brokerId = autoBroker?.id ?? null;

  const [st] = await db
    .insert(strategies)
    .values({
      name,
      template: templateId,
      underlying,
      exchange: underlying === "SENSEX" || underlying === "BANKEX" ? "BSE" : "NSE",
      expiry,
      spot: quote.ltp,
      lots,
      lotSize: inst.lotSize,
      netPremium: payoff.netCashflow,
      maxProfit: payoff.maxProfit,
      maxLoss: payoff.maxLoss,
      breakevens: payoff.breakevens,
      marginRequired: payoff.marginRequired,
      status: "DRAFT",
      notes: String(b.notes || ""),
    })
    .returning();

  const values = payoff.legs.map((l, i) => {
    const prot = legProtective(l, quote.ltp);
    const sym = l.instrumentType === "FUT" ? `${underlying}${expiry.replace(/-/g, "").slice(2)}FUT` : `${underlying}${expiry.replace(/-/g, "").slice(2)}${l.strike}${l.instrumentType}`;
    const tpl = templateById(templateId);
    const trig = b.indicatorTrigger || tpl.indicatorTrigger;
    let triggerMode = "MANUAL";
    if (trig) {
      if (trig.indicator === "RSI_CROSSOVER") {
        triggerMode = trig.condition === "BUY" ? "RSI_CROSS_BUY" : "RSI_CROSS_SELL";
      } else if (trig.indicator === "ORB_BREAKOUT") {
        triggerMode = trig.condition === "BUY" ? "ORB_BREAKOUT_BUY" : "ORB_BREAKDOWN_SELL";
      } else if (trig.indicator === "EMA_CROSS") {
        const isCall = trig.condition === "BUY";
        const c = trig.confirmCandles ?? 0;
        if (c === 1) triggerMode = isCall ? "EMA9_21_CROSS_CALL_1C" : "EMA9_21_CROSS_PUT_1C";
        else if (c === 2) triggerMode = isCall ? "EMA9_21_CROSS_CALL_2C" : "EMA9_21_CROSS_PUT_2C";
        else triggerMode = isCall ? "EMA9_21_CROSS_CALL_RUNNING" : "EMA9_21_CROSS_PUT_RUNNING";
      }
    }

    return {
      name: `${name} · L${i + 1} ${l.side} ${l.strike || "FUT"}${l.instrumentType}`,
      brokerId,
      symbol: sym,
      underlying,
      exchange: isCryptoStrat ? "DELTA" : underlying === "SENSEX" || underlying === "BANKEX" ? "BSE" : "NSE",
      segment: isCryptoStrat ? "CRYPTO" : l.instrumentType === "FUT" ? "FUT" : "OPT",
      instrumentType: l.instrumentType,
      strike: l.instrumentType === "FUT" ? null : l.strike,
      expiry,
      side: l.side,
      quantity: isCryptoStrat ? l.ratio : l.quantity,
      productType: "NRML",
      orderType: "MARKET",
      entryTrigger: triggerMode,
      entryPrice: l.premium,
      stopLoss: prot.stopLoss,
      target: prot.target,
      status: "DRAFT",
      strategyId: st.id,
      legIndex: i,
      notes: `${tpl.name} leg ${i + 1} (${l.ratio}× lot)${trig ? ` · Trigger: ${trig.indicator} ${trig.condition}` : ""}`,
      meta: { ratio: l.ratio, premium: l.premium, indicatorTrigger: trig },
    } satisfies typeof setups.$inferInsert;
  });
  const created: Setup[] = values.length ? await db.insert(setups).values(values).returning() : [];
  return Response.json({ strategy: st, setups: created }, { status: 201 });
}

/** DELETE /api/strategies?ids=1,2 */
export async function DELETE(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get("ids") || "")
    .split(",")
    .map((x) => Number(x))
    .filter((x) => !Number.isNaN(x) && x > 0);
  if (!ids.length) return Response.json({ error: "ids required" }, { status: 400 });
  const legs = await db.select().from(setups).where(inArray(setups.strategyId, ids));
  if (legs.some((l) => l.status === "ENTERED")) return Response.json({ error: "Exit open legs first" }, { status: 400 });
  await db.delete(setups).where(inArray(setups.strategyId, ids));
  await db.delete(strategies).where(inArray(strategies.id, ids));
  return Response.json({ ok: true });
}
