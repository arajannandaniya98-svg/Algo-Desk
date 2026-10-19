import { db } from "@/db";
import { brokers, orders, setups, type Broker, type Setup } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { placeOrder, resolveAutoBroker, type OrderRequest } from "./brokers";
import { capitalSnapshot, getSettings, marginForPosition, usdInrRate } from "./capital";
import type { FeedHub } from "./feed/hub";
import { resolveFeedInstrument } from "./feed/tokens";
import { deltaFeed } from "./feed/delta";
import type { FeedInstrument, LiveTick } from "./feed/types";
import { getInstrument, getQuotes, priceFor } from "./market";
import { openBroker } from "./security/secrets";
import { applyLivePrice, getCandles, type Interval } from "./candles";
import { analyse } from "./indicators";

export type ExecResult = { ok: boolean; message: string; filledPrice?: number | null; pnl?: number };
export type EngineEvent = { setupId: number; name: string; event: string; price: number; origin: "POLL" | "TICK" | "AUTO"; at: number };

type EngineGlobals = {
  locks: Set<number>;
  trail: Map<number, { best: number; trailSl: number; savedAt: number }>;
  events: EngineEvent[];
  tickEngine: boolean;
  autoCooldown: Map<string, number>;
};
const g = globalThis as unknown as { __algodeskEngine?: EngineGlobals };
const G: EngineGlobals = (g.__algodeskEngine ??= { locks: new Set(), trail: new Map(), events: [], tickEngine: false, autoCooldown: new Map() });

export async function currentPrice(s: Setup): Promise<number | null> {
  return priceFor({ symbol: s.symbol, underlying: s.underlying, instrumentType: s.instrumentType, strike: s.strike, expiry: s.expiry, exchange: s.exchange });
}

export function computePnl(s: Setup, exitPrice: number): number {
  if (s.entryFilledPrice == null) return 0;
  const dir = s.side === "BUY" ? 1 : -1;
  let mult = 1;
  if (s.exchange === "DELTA") {
    const m = (s.meta ?? {}) as { ctv?: number; fx?: number };
    mult = (m.ctv && m.ctv > 0 ? m.ctv : /BTC/.test(s.symbol) ? 0.001 : 0.01) * (m.fx && m.fx > 0 ? m.fx : 88);
  }
  return +((exitPrice - s.entryFilledPrice) * dir * s.quantity * mult).toFixed(2);
}

async function getBroker(id: number | null): Promise<Broker | null> {
  if (!id) return null;
  const [row] = await db.select().from(brokers).where(eq(brokers.id, id)).limit(1);
  return row ? openBroker(row) : null;
}

async function reload(id: number): Promise<Setup | null> {
  const [row] = await db.select().from(setups).where(eq(setups.id, id)).limit(1);
  return row ?? null;
}

async function withLock(id: number, fn: () => Promise<ExecResult>): Promise<ExecResult> {
  if (G.locks.has(id)) return { ok: false, message: "Order already in progress for this setup" };
  G.locks.add(id);
  try {
    return await fn();
  } finally {
    G.locks.delete(id);
  }
}

const feedType = (s: Setup) => (s.segment === "INDEX" && s.instrumentType === "EQ" ? "INDEX" : s.instrumentType);

async function orderIdentity(s: Setup, broker: Broker | null): Promise<{ brokerToken: string; symbol: string }> {
  if (s.brokerToken || !broker || broker.mode !== "live" || (broker.provider !== "dhan" && broker.provider !== "angelone")) return { brokerToken: s.brokerToken, symbol: s.symbol };
  const inst = await resolveFeedInstrument(broker.provider, { symbol: s.symbol, underlying: s.underlying || s.symbol, instrumentType: feedType(s), strike: s.strike, expiry: s.expiry, exchange: s.exchange });
  return { brokerToken: inst?.token ?? "", symbol: inst?.tradingSymbol || s.symbol };
}

export async function executeEntry(s0: Setup, reason = "MANUAL"): Promise<ExecResult> {
  return withLock(s0.id, async () => {
    const s = await reload(s0.id);
    if (!s) return { ok: false, message: "Setup not found" };
    if (s.status === "ENTERED") return { ok: false, message: "Already in position" };
    if (reason.startsWith("AUTO") && s.status !== "ACTIVE") return { ok: false, message: "Setup is no longer armed" };
    const ltp = await currentPrice(s);
    if (ltp == null) return { ok: false, message: "Price unavailable for symbol" };
    let broker = await getBroker(s.brokerId);
    if (!broker) {
      broker = await resolveAutoBroker({ exchange: s.exchange, symbol: s.symbol, segment: s.segment, preferredBrokerId: s.brokerId });
    }

    const snap = await capitalSnapshot();
    let fx = 1;
    let ctv = 1;
    if (s.exchange === "DELTA") {
      fx = await usdInrRate();
      const { deltaContractValue } = await import("./data/delta");
      ctv = await deltaContractValue(s.symbol);
    }
    const need = marginForPosition({ instrumentType: s.instrumentType, segment: s.segment, side: s.side, price: ltp, spot: ltp, quantity: s.quantity, productType: s.productType }) * fx * ctv;
    if (snap.settings.enforceCapital && need > snap.freeMargin) {
      await db.insert(orders).values({
        setupId: s.id,
        brokerId: s.brokerId,
        provider: broker?.provider ?? "paper",
        mode: broker?.mode ?? "paper",
        symbol: s.symbol,
        exchange: s.exchange,
        side: s.side,
        quantity: s.quantity,
        orderType: s.orderType,
        productType: s.productType,
        price: ltp,
        status: "REJECTED",
        action: "ENTRY",
        message: `Capital guard: need ₹${need.toFixed(0)} margin, free only ₹${snap.freeMargin.toFixed(0)} of ₹${snap.capital.toFixed(0)}`,
      });
      return { ok: false, message: `Capital guard blocked entry — need ₹${need.toFixed(0)} margin, free ₹${snap.freeMargin.toFixed(0)}.` };
    }
    if (snap.dayLossHit) return { ok: false, message: `Daily loss limit hit. No new entries today.` };

    const ident = await orderIdentity(s, broker);
    const price = s.orderType === "LIMIT" && s.entryPrice ? s.entryPrice : ltp;
    const req: OrderRequest = {
      symbol: ident.symbol,
      exchange: s.exchange,
      segment: s.segment,
      instrumentType: s.instrumentType,
      side: s.side as "BUY" | "SELL",
      quantity: s.quantity,
      orderType: s.orderType as "MARKET" | "LIMIT",
      productType: s.productType as "MIS" | "CNC" | "NRML",
      price,
      brokerToken: ident.brokerToken,
    };
    const res = await placeOrder(broker, req);
    const filled = res.filledPrice ?? (res.ok ? price : null);
    await db.insert(orders).values({
      setupId: s.id,
      brokerId: broker?.id ?? null,
      provider: broker?.provider ?? "paper",
      mode: broker?.mode ?? "paper",
      symbol: ident.symbol,
      exchange: s.exchange,
      side: s.side,
      quantity: s.quantity,
      orderType: s.orderType,
      productType: s.productType,
      price,
      filledPrice: filled,
      status: res.status,
      action: "ENTRY",
      brokerOrderId: res.brokerOrderId,
      message: `${reason}: ${res.message}`,
    });
    if (res.ok) {
      G.trail.delete(s.id);
      const meta: Record<string, unknown> = s.exchange === "DELTA" ? { ctv, fx } : {};
      await db.update(setups).set({ status: "ENTERED", entryFilledPrice: filled, entryAt: new Date(), meta, updatedAt: new Date() }).where(eq(setups.id, s.id));
    }
    return { ok: res.ok, message: res.message, filledPrice: filled };
  });
}

export async function executeExit(s0: Setup, reason = "MANUAL"): Promise<ExecResult> {
  return withLock(s0.id, async () => {
    const s = await reload(s0.id);
    if (!s || s.status !== "ENTERED") return { ok: false, message: "No open position" };
    const ltp = await currentPrice(s);
    if (ltp == null) return { ok: false, message: "Price unavailable for symbol" };
    let broker = await getBroker(s.brokerId);
    if (!broker) {
      broker = await resolveAutoBroker({ exchange: s.exchange, symbol: s.symbol, segment: s.segment, preferredBrokerId: s.brokerId });
    }
    const ident = await orderIdentity(s, broker);
    const exitSide = s.side === "BUY" ? "SELL" : "BUY";
    const req: OrderRequest = {
      symbol: ident.symbol,
      exchange: s.exchange,
      segment: s.segment,
      instrumentType: s.instrumentType,
      side: exitSide,
      quantity: s.quantity,
      orderType: "MARKET",
      productType: s.productType as "MIS" | "CNC" | "NRML",
      price: ltp,
      brokerToken: ident.brokerToken,
    };
    const res = await placeOrder(broker, req);
    const filled = res.filledPrice ?? (res.ok ? ltp : null);
    await db.insert(orders).values({
      setupId: s.id,
      brokerId: broker?.id ?? null,
      provider: broker?.provider ?? "paper",
      mode: broker?.mode ?? "paper",
      symbol: ident.symbol,
      exchange: s.exchange,
      side: exitSide,
      quantity: s.quantity,
      orderType: "MARKET",
      productType: s.productType,
      price: ltp,
      filledPrice: filled,
      status: res.status,
      action: "EXIT",
      brokerOrderId: res.brokerOrderId,
      message: `${reason}: ${res.message}`,
    });
    if (!res.ok) return { ok: false, message: res.message };
    const pnl = computePnl(s, filled ?? ltp);
    G.trail.delete(s.id);
    await db.update(setups).set({ status: "EXITED", exitFilledPrice: filled, exitAt: new Date(), exitReason: reason, pnl, updatedAt: new Date() }).where(eq(setups.id, s.id));
    return { ok: true, message: res.message, filledPrice: filled, pnl };
  });
}

function calculateEMA(data: number[], period: number): number[] {
  if (!data || data.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

async function evaluateSetup(s: Setup, ltp: number, origin: "POLL" | "TICK"): Promise<EngineEvent | null> {
  const mkEvent = (event: string, price: number): EngineEvent => ({ setupId: s.id, name: s.name, event, price, origin, at: Date.now() });
  const tag = origin === "TICK" ? " · tick" : "";

  if (s.status === "ACTIVE") {
    let hit = s.entryPrice != null && ((s.entryTrigger === "PRICE_ABOVE" && ltp >= s.entryPrice) || (s.entryTrigger === "PRICE_BELOW" && ltp <= s.entryPrice));

    // 1. RSI Crossover Entry Triggers
    if (!hit && (s.entryTrigger === "RSI_CROSS_BUY" || s.entryTrigger === "RSI_CROSS_SELL")) {
      const set = await getCandles(s.underlying || s.symbol, "15m");
      if (set && set.candles.length >= 20) {
        const sig = analyse(applyLivePrice(set.candles, ltp));
        if (sig?.rsiCrossover) {
          if (s.entryTrigger === "RSI_CROSS_BUY" && sig.rsiCrossover.signal === "BUY") {
            hit = true;
          } else if (s.entryTrigger === "RSI_CROSS_SELL" && sig.rsiCrossover.signal === "SELL") {
            hit = true;
          }
        }
      }
    }

    // 2. EMA 9/21 Crossover Entry Triggers (5-minute timeframe, 1 candle close confirmation)
    if (!hit && (s.entryTrigger === "EMA_CROSS_BUY" || s.entryTrigger === "EMA_CROSS_SELL")) {
      const set = await getCandles(s.underlying || s.symbol, "5m"); 
      if (set && set.candles.length >= 25) {
        const closes = set.candles.map(c => c.c);
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);

        const len = closes.length;
        const prev1_9 = ema9[len - 2];  
        const prev1_21 = ema21[len - 2];
        const prev2_9 = ema9[len - 3];  
        const prev2_21 = ema21[len - 3];

        if (s.entryTrigger === "EMA_CROSS_BUY") {
          if (prev1_9 > prev1_21 && prev2_9 <= prev2_21) hit = true;
        } else if (s.entryTrigger === "EMA_CROSS_SELL") {
          if (prev1_9 < prev1_21 && prev2_9 >= prev2_21) hit = true;
        }
      }
    }

    // 3. ORB (Opening Range Breakout) Entry Triggers
    if (!hit && (s.entryTrigger === "ORB_BUY" || s.entryTrigger === "ORB_SELL")) {
      const set = await getCandles(s.underlying || s.symbol, "15m"); 
      if (set && set.candles.length > 0) {
        const todayStr = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
        const todaysCandles = set.candles.filter(c => 
          new Date(c.t).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) === todayStr
        );

        if (todaysCandles.length > 0) {
          const firstCandle = todaysCandles[0]; 
          
          if (s.entryTrigger === "ORB_BUY" && ltp > firstCandle.h) {
            hit = true; 
          } else if (s.entryTrigger === "ORB_SELL" && ltp < firstCandle.l) {
            hit = true; 
          }
        }
      }
    }

    if (!hit) return null;
    const r = await executeEntry(s, `AUTO ${s.entryTrigger}${tag}`);
    if (!r.ok && /already|no longer|in progress/i.test(r.message)) return null;
    return mkEvent(r.ok ? "ENTRY" : "ENTRY_FAILED", r.filledPrice ?? ltp);
  }
  if (s.status !== "ENTERED") return null;

  const isBuy = s.side === "BUY";
  let reason: string | null = null;
  if (s.trailingSl && s.trailingSl > 0 && s.entryFilledPrice != null) {
    const meta = (s.meta ?? {}) as { best?: number; trailSl?: number };
    const st = G.trail.get(s.id) ?? { best: meta.best ?? ltp, trailSl: meta.trailSl ?? s.stopLoss ?? (isBuy ? -Infinity : Infinity), savedAt: 0 };
    st.best = isBuy ? Math.max(st.best, ltp) : Math.min(st.best, ltp);
    const candidate = isBuy ? st.best - s.trailingSl : st.best + s.trailingSl;
    if (isBuy ? candidate > st.trailSl : candidate < st.trailSl) st.trailSl = +candidate.toFixed(2);
    G.trail.set(s.id, st);
    if (Date.now() - st.savedAt > 3000) {
      st.savedAt = Date.now();
      void db.update(setups).set({ meta: { ...meta, best: st.best, trailSl: st.trailSl } }).where(eq(setups.id, s.id)).then(() => {}, () => {});
    }
    if (Number.isFinite(st.trailSl) && (isBuy ? ltp <= st.trailSl : ltp >= st.trailSl)) reason = "TRAILING_SL";
  }
  if (!reason && s.stopLoss != null && s.stopLoss > 0 && (isBuy ? ltp <= s.stopLoss : ltp >= s.stopLoss)) reason = "STOPLOSS";
  if (!reason && s.target != null && s.target > 0 && (isBuy ? ltp >= s.target : ltp <= s.target)) reason = "TARGET";

  // RSI Crossover Exit
  if (!reason && s.notes && (s.notes.includes("RSI") || s.entryTrigger.includes("RSI"))) {
    const set = await getCandles(s.underlying || s.symbol, "15m");
    if (set && set.candles.length >= 20) {
      const sig = analyse(applyLivePrice(set.candles, ltp));
      if (sig?.rsiCrossover) {
        if (isBuy && sig.rsiCrossover.signal === "SELL") {
          reason = "RSI_CROSSOVER_EXIT";
        } else if (!isBuy && sig.rsiCrossover.signal === "BUY") {
          reason = "RSI_CROSSOVER_EXIT";
        }
      }
    }
  }

  // EMA 9/21 Crossover Exit 
  if (!reason && (s.entryTrigger === "EMA_CROSS_BUY" || s.entryTrigger === "EMA_CROSS_SELL")) {
    const set = await getCandles(s.underlying || s.symbol, "5m");
    if (set && set.candles.length >= 25) {
      const closes = set.candles.map(c => c.c);
      const ema9 = calculateEMA(closes, 9);
      const ema21 = calculateEMA(closes, 21);

      const len = closes.length;
      const prev1_9 = ema9[len - 2];
      const prev1_21 = ema21[len - 2];
      const prev2_9 = ema9[len - 3];
      const prev2_21 = ema21[len - 3];

      if (s.entryTrigger === "EMA_CROSS_BUY") {
        if (prev1_9 < prev1_21 && prev2_9 >= prev2_21) reason = "EMA_CROSSOVER_EXIT";
      } else if (s.entryTrigger === "EMA_CROSS_SELL") {
        if (prev1_9 > prev1_21 && prev2_9 <= prev2_21) reason = "EMA_CROSSOVER_EXIT";
      }
    }
  }

  if (!reason) return null;
  const r = await executeExit(s, `${reason}${tag}`);
  if (!r.ok && /no open position|in progress/i.test(r.message)) return null;
  return mkEvent(r.ok ? reason : "EXIT_FAILED", r.filledPrice ?? ltp);
}

export async function runAutoTradePass(): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  try {
    const settings = await getSettings();
    const at = settings.autoTrade;
    if (!at || !at.enabled || !at.symbols || !at.symbols.length) return [];

    const snap = await capitalSnapshot();
    if (snap.dayLossHit || snap.freeMargin < 1000) return [];

    const live = await db.select().from(setups).where(inArray(setups.status, ["ACTIVE", "ENTERED"]));
    const openSymbols = new Set(live.map((s) => s.symbol));
    const openCount = live.filter((s) => s.status === "ENTERED").length;

    for (const s of live) {
      if (s.status !== "ENTERED") continue;
      const set = await getCandles(s.symbol, (at.interval || "15m") as Interval);
      if (!set) continue;
      const ltp = await currentPrice(s);
      if (!ltp) continue;
      const sig = analyse(applyLivePrice(set.candles, ltp), settings.indicatorConfig);
      if (!sig) continue;
      const isOpposite =
        (s.side === "BUY" && sig.signal === "SELL" && sig.score <= -at.minScore) ||
        (s.side === "SELL" && sig.signal === "BUY" && sig.score >= at.minScore);
      if (isOpposite) {
        const exitRes = await executeExit(s, `AUTO SIGNAL FLIP (${sig.signal})`);
        if (exitRes.ok) {
          events.push({ setupId: s.id, name: s.name, event: `SIGNAL_FLIP_${sig.signal}`, price: exitRes.filledPrice ?? ltp, origin: "AUTO", at: Date.now() });
        }
      }
    }

    if (openCount >= (at.maxPositions || 3)) return events;

    const defBroker = (await db.select().from(brokers).where(eq(brokers.isDefault, true)).limit(1))[0] ?? null;
    const now = Date.now();

    for (const sym of at.symbols) {
      if (openSymbols.has(sym)) continue;
      const lastAt = G.autoCooldown.get(sym) ?? 0;
      if (now - lastAt < 120_000) continue; 

      const inst = await getInstrument(sym);
      if (!inst) continue;
      const set = await getCandles(sym, (at.interval || "15m") as Interval);
      if (!set) continue;
      const quote = (await getQuotes([sym]))[sym];
      const ltp = quote?.ltp ?? (set.candles[set.candles.length - 1]?.c || 0);
      if (!ltp) continue;
      const sig = analyse(applyLivePrice(set.candles, ltp), settings.indicatorConfig);
      if (!sig || sig.signal === "HOLD") continue;

      const trigger =
        (sig.signal === "BUY" && sig.score >= at.minScore) ||
        (sig.signal === "SELL" && sig.score <= -at.minScore);
      if (!trigger) continue;

      G.autoCooldown.set(sym, now);
      const isIndex = inst.segment === "INDEX";
      const isCrypto = inst.exchange === "DELTA" || sym.endsWith("USD");
      const lotSize = isCrypto ? 1 : inst.lotSize || 1;
      const qty = (at.defaultLots || 1) * lotSize;

      const autoBroker = await resolveAutoBroker({
        exchange: isCrypto ? "DELTA" : isIndex ? "NSE" : inst.exchange || "NSE",
        symbol: sym,
        segment: isCrypto ? "CRYPTO" : isIndex ? "FUT" : inst.segment || "EQ",
      });

      const [newSetup] = await db
        .insert(setups)
        .values({
          name: `${sym} 🤖 AUTO ${sig.signal} (${sig.score > 0 ? "+" : ""}${sig.score})`,
          symbol: sym,
          underlying: isIndex || isCrypto ? sym : "",
          exchange: isCrypto ? "DELTA" : isIndex ? "NSE" : inst.exchange || "NSE",
          segment: isCrypto ? "CRYPTO" : isIndex ? "FUT" : inst.segment || "EQ",
          instrumentType: isCrypto ? "FUT" : isIndex ? "FUT" : "EQ",
          side: sig.signal,
          quantity: qty,
          productType: isIndex || isCrypto ? "NRML" : "MIS",
          orderType: "MARKET",
          entryTrigger: "MANUAL",
          entryPrice: ltp,
          stopLoss: sig.levels.stopLoss,
          target: sig.levels.target,
          trailingSl: Math.round(sig.levels.atr * 1.5 * 100) / 100,
          brokerId: autoBroker?.id ?? defBroker?.id ?? null,
          status: "ACTIVE",
          notes: `Auto-traded on ${sig.signal} signal (Score ${sig.score}, ${sig.strength}) · ATR ${sig.levels.atr}`,
        })
        .returning();

      if (newSetup) {
        const r = await executeEntry(newSetup, `AUTO SIGNAL ${sig.signal}`);
        events.push({ setupId: newSetup.id, name: newSetup.name, event: r.ok ? `AUTO_ENTRY_${sig.signal}` : "AUTO_ENTRY_FAILED", price: r.filledPrice ?? ltp, origin: "AUTO", at: Date.now() });
        openSymbols.add(sym);
      }
    }
  } catch {
    // ignore
  }
  return events;
}

export async function runEngineTick() {
  const live = await db.select().from(setups).where(inArray(setups.status, ["ACTIVE", "ENTERED"]));
  const events: EngineEvent[] = [];
  for (const s of live) {
    if (G.locks.has(s.id)) continue;
    const ltp = await currentPrice(s);
    if (ltp == null) continue;
    const ev = await evaluateSetup(s, ltp, "POLL");
    if (ev) events.push(ev);
  }
  const autoEvents = await runAutoTradePass();
  const tickEvents = G.events.splice(0, G.events.length);
  return { checked: live.length, events: [...tickEvents, ...events, ...autoEvents] };
}

export function attachTickEngine(hub: FeedHub) {
  if (G.tickEngine) return;
  G.tickEngine = true;
  let watch = new Map<string, number[]>();
  const setupCache = new Map<number, Setup>();
  const inflight = new Set<number>();

  const refresh = async () => {
    const p = hub.provider;
    const brokerLive = hub.isLive() && p && p !== "demo";
    const rows = await db.select().from(setups).where(inArray(setups.status, ["ACTIVE", "ENTERED"]));
    const next = new Map<string, number[]>();
    const insts: FeedInstrument[] = [];
    const cryptoInsts: FeedInstrument[] = [];
    setupCache.clear();
    for (const s of rows) {
      const isCrypto = s.exchange === "DELTA";
      if (!isCrypto && !brokerLive) continue;
      const inst = await resolveFeedInstrument(isCrypto ? "delta" : (p as "dhan" | "angelone"), {
        symbol: s.symbol, underlying: s.underlying || s.symbol, instrumentType: feedType(s), strike: s.strike, expiry: s.expiry, exchange: s.exchange,
      });
      if (!inst) continue;
      (isCrypto ? cryptoInsts : insts).push(inst);
      next.set(inst.key, [...(next.get(inst.key) ?? []), s.id]);
      setupCache.set(s.id, s);
    }
    if (brokerLive) hub.lease(insts, 30_000);
    if (cryptoInsts.length) deltaFeed().lease(cryptoInsts, 30_000);
    watch = next;
  };
  const timer = setInterval(() => {
    refresh().catch(() => {});
  }, 3000);
  timer.unref?.();

  hub.on("tick", (t: LiveTick) => {
    if (t.simulated) return;
    const ids = watch.get(t.key);
    if (!ids) return;
    for (const id of ids) {
      const s = setupCache.get(id);
      if (!s || inflight.has(id) || G.locks.has(id)) continue;
      inflight.add(id);
      evaluateSetup(s, t.ltp, "TICK")
        .then(async (ev) => {
          if (!ev) return;
          G.events.push(ev);
          if (G.events.length > 200) G.events.splice(0, G.events.length - 200);
          const fresh = await reload(id);
          if (fresh && (fresh.status === "ACTIVE" || fresh.status === "ENTERED")) setupCache.set(id, fresh);
          else setupCache.delete(id);
        })
        .catch(() => {})
        .finally(() => inflight.delete(id));
    }
  });
  refresh().catch(() => {});
}