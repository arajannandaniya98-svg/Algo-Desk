import { db } from "@/db";
import { appSettings, setups, type AppSettings, type Setup } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { currentPrice } from "./engine";

export const DEFAULT_SETTINGS: AppSettings = {
  id: 1,
  capital: 10000,
  riskPerTradePct: 1,
  maxDailyLossPct: 3,
  enforceCapital: true,
  autoExcelMinutes: 5,
  feedBrokerId: null,
  feedAutoStart: false,
  tokenSync: {},
  autoTrade: {
    enabled: false,
    symbols: ["NIFTY", "BANKNIFTY", "RELIANCE", "BTCUSD"],
    interval: "15m",
    maxPositions: 3,
    minScore: 40,
    defaultLots: 1,
  },
  indicatorConfig: {},
  updatedAt: new Date(),
};

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (rows[0]) return rows[0];
  const [row] = await db.insert(appSettings).values({ id: 1, capital: 10000 }).onConflictDoNothing().returning();
  return row ?? DEFAULT_SETTINGS;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  await getSettings();
  const clean: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.capital != null && !Number.isNaN(Number(patch.capital))) clean.capital = Math.max(0, Number(patch.capital));
  if (patch.riskPerTradePct != null) clean.riskPerTradePct = Math.min(100, Math.max(0.05, Number(patch.riskPerTradePct)));
  if (patch.maxDailyLossPct != null) clean.maxDailyLossPct = Math.min(100, Math.max(0.1, Number(patch.maxDailyLossPct)));
  if (typeof patch.enforceCapital === "boolean") clean.enforceCapital = patch.enforceCapital;
  if (patch.autoExcelMinutes != null) clean.autoExcelMinutes = Math.min(120, Math.max(0, Math.round(Number(patch.autoExcelMinutes))));
  if (patch.autoTrade != null) clean.autoTrade = patch.autoTrade;
  if (patch.indicatorConfig != null) clean.indicatorConfig = patch.indicatorConfig;
  const [row] = await db.update(appSettings).set(clean).where(eq(appSettings.id, 1)).returning();
  return row ?? DEFAULT_SETTINGS;
}

/** Approximate margin/blocked funds for a position (SPAN+exposure approximation) */
export function marginForPosition(opts: { instrumentType: string; segment: string; side: string; price: number; spot: number; quantity: number; productType: string }): number {
  const { instrumentType: type, segment, side, price, spot, quantity: qty, productType } = opts;
  if (!price || !qty) return 0;
  const isIndex = segment === "INDEX" || segment === "OPT" || segment === "FUT";
  if (type === "EQ") {
    if (productType === "CNC") return price * qty;
    if (productType === "NRML") return price * qty * 0.35;
    return price * qty * 0.2; // MIS ~5x
  }
  if (segment === "CRYPTO") {
    // Delta contract_value ≈ 0.001 BTC / 0.01 ETH etc. — price here is per-contract premium or index;
    // approximate: futures 10% notional, option buy = premium, option sell = 20% notional
    if (type === "CE" || type === "PE") return side === "BUY" ? price * qty : spot * qty * 0.2;
    return price * qty * 0.1;
  }
  if (type === "FUT") return spot * qty * (isIndex ? 0.15 : 0.22);
  if (type === "CE" || type === "PE") {
    if (side === "BUY") return price * qty; // premium debit
    // short option: ~12% index / 18% stock notional + premium credit
    return spot * qty * (isIndex ? 0.12 : 0.18) + price * qty * 0.5;
  }
  return price * qty;
}

/** USD→INR rate for crypto margin (Delta settles in USD). */
let fxCache: { v: number; at: number } | null = null;
export async function usdInrRate(): Promise<number> {
  if (fxCache && Date.now() - fxCache.at < 300_000) return fxCache.v;
  try {
    const { getQuotes } = await import("./market");
    const q = await getQuotes(["USDINR"]);
    const v = q.USDINR?.ltp;
    if (v && v > 50 && v < 150) {
      fxCache = { v, at: Date.now() };
      return v;
    }
  } catch {
    /* fallback */
  }
  return 88;
}

/** Live margin for a setup row */
export async function marginForSetup(s: Setup): Promise<number> {
  const ltp = await currentPrice(s);
  if (ltp == null) return 0;
  let fx = 1;
  let ctv = 1;
  if (s.exchange === "DELTA") {
    fx = await usdInrRate();
    const { deltaContractValue } = await import("./data/delta");
    ctv = await deltaContractValue(s.symbol);
  }
  if (fx !== 1 || ctv !== 1)
    return (
      ctv *
      marginForPosition({
        instrumentType: s.instrumentType,
        segment: s.segment,
        side: s.side,
        price: ltp,
        spot: ltp,
        quantity: s.quantity,
        productType: s.productType,
      }) * fx
    );
  return marginForPosition({
    instrumentType: s.instrumentType,
    segment: s.segment,
    side: s.side,
    price: ltp,
    spot: ltp,
    quantity: s.quantity,
    productType: s.productType,
  });
}

export interface CapitalSnapshot {
  settings: AppSettings;
  capital: number;
  usedMargin: number;
  freeMargin: number;
  realized: number;
  unrealized: number;
  dayPnl: number;
  equity: number;
  exposurePct: number;
  returnPct: number;
  dayLossLimit: number;
  dayLossHit: boolean;
  marginBySetup: { id: number; name: string; margin: number }[];
}

export async function capitalSnapshot(): Promise<CapitalSnapshot> {
  const settings = await getSettings();
  const open = await db.select().from(setups).where(inArray(setups.status, ["ACTIVE", "ENTERED"]));
  const entered = open.filter((s) => s.status === "ENTERED");

  const marginBySetup: CapitalSnapshot["marginBySetup"] = [];
  let usedMargin = 0;
  let unrealized = 0;
  for (const s of entered) {
    const m = await marginForSetup(s);
    const ltp = await currentPrice(s);
    usedMargin += m;
    marginBySetup.push({ id: s.id, name: s.name, margin: +m.toFixed(2) });
    if (ltp != null && s.entryFilledPrice != null) {
      unrealized += (ltp - s.entryFilledPrice) * (s.side === "BUY" ? 1 : -1) * s.quantity;
    }
  }

  const closed = await db.select().from(setups).where(eq(setups.status, "EXITED"));
  const realized = closed.reduce((a, s) => a + s.pnl, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayPnl = closed.filter((s) => s.exitAt && s.exitAt >= today).reduce((a, s) => a + s.pnl, 0) + unrealized;

  const equity = settings.capital + realized + unrealized;
  const dayLossLimit = (settings.capital * settings.maxDailyLossPct) / 100;
  return {
    settings,
    capital: settings.capital,
    usedMargin: +usedMargin.toFixed(2),
    freeMargin: +Math.max(settings.capital - usedMargin, 0).toFixed(2),
    realized: +realized.toFixed(2),
    unrealized: +unrealized.toFixed(2),
    dayPnl: +dayPnl.toFixed(2),
    equity: +equity.toFixed(2),
    exposurePct: settings.capital ? +((usedMargin / settings.capital) * 100).toFixed(1) : 0,
    returnPct: settings.capital ? +(((realized + unrealized) / settings.capital) * 100).toFixed(2) : 0,
    dayLossLimit: +dayLossLimit.toFixed(2),
    dayLossHit: dayPnl <= -dayLossLimit,
    marginBySetup,
  };
}

/** Risk-based position size: risk = capital × risk% ; qty = risk / per-unit risk */
export function riskBasedQuantity(opts: { capital: number; riskPct: number; entry: number; stopLoss: number; lotSize: number; instrumentType: string }): { quantity: number; lots: number; riskAmount: number; perUnitRisk: number } {
  const { capital, riskPct, entry, stopLoss, lotSize, instrumentType } = opts;
  const riskAmount = (capital * riskPct) / 100;
  const perUnitRisk = Math.abs(entry - stopLoss);
  if (!perUnitRisk || !entry) return { quantity: instrumentType === "EQ" ? 1 : lotSize, lots: 1, riskAmount: +riskAmount.toFixed(2), perUnitRisk: 0 };
  if (instrumentType === "EQ") {
    const qty = Math.max(1, Math.floor(riskAmount / perUnitRisk));
    return { quantity: qty, lots: 0, riskAmount: +riskAmount.toFixed(2), perUnitRisk: +perUnitRisk.toFixed(2) };
  }
  const lots = Math.max(1, Math.floor(riskAmount / (perUnitRisk * lotSize)));
  return { quantity: lots * lotSize, lots, riskAmount: +riskAmount.toFixed(2), perUnitRisk: +perUnitRisk.toFixed(2) };
}
