import ExcelJS from "exceljs";
import { getCandles, type Interval } from "./candles";
import { bsPrice, getInstrument, strikeStep } from "./market";
import type { LegSpec } from "./strategies";

export interface BacktestTrade {
  id: number;
  entryTime: string;
  exitTime: string;
  entrySpot: number;
  exitSpot: number;
  spotChangePct: number;
  entryNetPremium: number;
  exitNetPremium: number;
  pnl: number;
  returnPct: number;
  exitReason: "TARGET" | "STOPLOSS" | "EXPIRY" | "SIGNAL_FLIP";
  durationBars: number;
  indicatorTrigger?: string;
}

export interface BacktestSummary {
  underlying: string;
  strategyName: string;
  interval: Interval;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  maxProfit: number;
  maxLoss: number;
  avgPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  riskReward: number;
  capitalUsed: number;
  returnOnCapital: number;
  trades: BacktestTrade[];
  equityCurve: { time: string; pnl: number; equity: number }[];
}

import type { IndicatorTriggerRule } from "./strategies";
import { analyse, type IndicatorConfig } from "./indicators";

export interface BacktestOptions {
  underlying: string;
  strategyName: string;
  interval: Interval;
  lots: number;
  legs: LegSpec[];
  targetPct?: number;   // e.g. 50% max profit target
  stopLossPct?: number; // e.g. 40% loss limit
  holdingBars?: number; // max bars to hold before exit (e.g. 15 bars)
  indicatorTrigger?: IndicatorTriggerRule;
  indicatorConfig?: Partial<IndicatorConfig>;
}

/**
 * Historical Backtesting for Options / Multi-leg strategies
 * Simulates sequential trades over historical candle periods
 */
export async function runStrategyBacktest(opts: BacktestOptions): Promise<BacktestSummary> {
  const { underlying, strategyName, interval, lots, legs, targetPct = 40, stopLossPct = 30, holdingBars = 16 } = opts;
  const inst = await getInstrument(underlying);
  const lotSize = inst?.lotSize || (underlying.endsWith("USD") ? 1 : 25);
  const volatility = inst?.volatility || 0.22;

  const candleSet = await getCandles(underlying, interval);
  const candles = candleSet?.candles || [];

  if (candles.length < 30) {
    throw new Error(`Insufficient historical candle data for ${underlying} (${candles.length} bars)`);
  }

  const trades: BacktestTrade[] = [];
  const equityCurve: { time: string; pnl: number; equity: number }[] = [];
  let cumPnl = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;

  // Assume starting capital allocated based on margin requirement
  const baseMarginPerLot = (candles[0].c * lotSize * 0.15) * lots;
  const capitalUsed = Math.max(10000, baseMarginPerLot);
  let currentEquity = capitalUsed;

  equityCurve.push({
    time: new Date(candles[0].t).toLocaleDateString("en-IN"),
    pnl: 0,
    equity: currentEquity,
  });

  const step = strikeStep(candles[0].c);

  // Helper to price a leg at a specific spot and remaining expiry days
  const priceLeg = (leg: LegSpec, spot: number, atm: number, tDays: number): number => {
    if (leg.instrumentType === "FUT") return spot;
    const strike = atm + leg.offset * step;
    const T = Math.max(0.001, tDays / 365);
    const r = 0.07;
    const res = bsPrice(spot, strike, T, r, volatility, leg.instrumentType);
    return Math.max(0.05, +res.price.toFixed(2));
  };

  // Run backtesting window: open trade, evaluate bar by bar, exit on Target/SL/Time
  let barIdx = 10;
  let tradeCounter = 1;

  while (barIdx < candles.length - 5) {
    // If an indicator trigger rule is configured, evaluate candles up to barIdx
    let triggerMatch = true;
    let triggerNote = "";
    if (opts.indicatorTrigger) {
      const rule = opts.indicatorTrigger;
      const historySlice = candles.slice(0, barIdx + 1);
      const sig = analyse(historySlice, opts.indicatorConfig);
      if (!sig) {
        barIdx++;
        continue;
      }

      if (rule.indicator === "SUPERTREND") {
        const st = sig.indicators.find((i) => i.id === "supertrend");
        triggerMatch = st?.vote === rule.condition;
        triggerNote = `Supertrend ${st?.vote}`;
      } else if (rule.indicator === "EMA_CROSS") {
        const em = sig.emaCrossover;
        const maxBars = rule.confirmCandles ?? 2;
        triggerMatch = em?.signal === rule.condition && (em?.barsSinceCross ?? 99) <= maxBars;
        triggerNote = em?.detail || `EMA ${rule.condition}`;
      } else if (rule.indicator === "ORB_BREAKOUT") {
        const orb = sig.orbBreakout;
        triggerMatch = orb?.signal === rule.condition;
        triggerNote = orb?.detail || `ORB ${rule.condition}`;
      } else if (rule.indicator === "RSI") {
        const rs = sig.indicators.find((i) => i.id === "rsi");
        triggerMatch = rs?.vote === rule.condition;
        triggerNote = `RSI ${rs?.vote}`;
      } else if (rule.indicator === "RSI_CROSSOVER") {
        triggerMatch = sig.rsiCrossover?.signal === rule.condition;
        triggerNote = sig.rsiCrossover?.detail || "RSI Crossover";
      } else if (rule.indicator === "MACD") {
        const mc = sig.indicators.find((i) => i.id === "macd");
        triggerMatch = mc?.vote === rule.condition;
        triggerNote = `MACD ${mc?.vote}`;
      } else if (rule.indicator === "ALL_COMBINED") {
        const minS = rule.minScore ?? 35;
        if (rule.condition === "BUY") {
          triggerMatch = sig.signal === "BUY" && sig.score >= minS;
        } else {
          triggerMatch = sig.signal === "SELL" && sig.score <= -minS;
        }
        triggerNote = `Score ${sig.score > 0 ? "+" : ""}${sig.score}`;
      }

      if (!triggerMatch) {
        barIdx++;
        continue; // advance until indicator triggers
      }
    }

    const entryBar = candles[barIdx];
    const entrySpot = entryBar.c;
    const atm = Math.round(entrySpot / step) * step;
    const expiryDays = 7; // standard weekly option assumption

    // Calculate Entry Net Premium
    let entryNetPrem = 0;
    for (const leg of legs) {
      const prem = priceLeg(leg, entrySpot, atm, expiryDays);
      const sign = leg.side === "BUY" ? -1 : 1;
      entryNetPrem += sign * prem * leg.ratio;
    }

    let exitReason: BacktestTrade["exitReason"] = "EXPIRY";
    let exitBar = entryBar;
    let exitSpot = entrySpot;
    let exitNetPrem = entryNetPrem;
    let duration = 1;

    // Simulate bars into the trade
    for (let h = 1; h <= holdingBars && barIdx + h < candles.length; h++) {
      duration = h;
      const curBar = candles[barIdx + h];
      exitBar = curBar;
      exitSpot = curBar.c;
      const curT = Math.max(0.01, expiryDays - (h / (interval === "1d" ? 1 : 25)));

      // Calculate current net premium value to square off
      let curNetPrem = 0;
      for (const leg of legs) {
        const curPrice = priceLeg(leg, exitSpot, atm, curT);
        const sign = leg.side === "BUY" ? 1 : -1; // square-off sign
        curNetPrem += sign * curPrice * leg.ratio;
      }

      // Net PnL points per single unit
      const netPoints = entryNetPrem + curNetPrem;
      const notionalRisk = Math.abs(entryNetPrem) || (entrySpot * 0.02);
      const curPctChange = (netPoints / notionalRisk) * 100;

      if (curPctChange >= targetPct) {
        exitReason = "TARGET";
        exitNetPrem = -curNetPrem;
        break;
      }
      if (curPctChange <= -stopLossPct) {
        exitReason = "STOPLOSS";
        exitNetPrem = -curNetPrem;
        break;
      }

      // Check signal flip exit if enabled
      if (opts.indicatorTrigger?.exitOnSignalFlip) {
        const sliceNow = candles.slice(0, barIdx + h + 1);
        const sigNow = analyse(sliceNow, opts.indicatorConfig);
        if (sigNow) {
          const rule = opts.indicatorTrigger;
          const oppSignal = rule.condition === "BUY" ? "SELL" : "BUY";
          let flip = false;
          if (rule.indicator === "SUPERTREND") {
            const st = sigNow.indicators.find((i) => i.id === "supertrend");
            flip = st?.vote === oppSignal;
          } else if (rule.indicator === "EMA_CROSS") {
            const em = sigNow.indicators.find((i) => i.id === "ema");
            flip = em?.vote === oppSignal;
          } else if (rule.indicator === "RSI_CROSSOVER") {
            flip = sigNow.rsiCrossover?.signal === oppSignal;
          } else {
            flip = sigNow.signal === oppSignal;
          }

          if (flip) {
            exitReason = "SIGNAL_FLIP";
            exitNetPrem = -curNetPrem;
            break;
          }
        }
      }

      if (h === holdingBars) {
        exitReason = "EXPIRY";
        exitNetPrem = -curNetPrem;
      }
    }

    // Trade Net PnL (in Currency)
    const pointsDiff = entryNetPrem - exitNetPrem;
    const tradeQty = lots * lotSize;
    const tradePnl = +(pointsDiff * tradeQty).toFixed(2);
    const returnPct = capitalUsed > 0 ? +((tradePnl / capitalUsed) * 100).toFixed(2) : 0;

    cumPnl += tradePnl;
    currentEquity += tradePnl;

    if (currentEquity > peakEquity) {
      peakEquity = currentEquity;
    }
    const curDd = peakEquity - currentEquity;
    if (curDd > maxDrawdown) {
      maxDrawdown = curDd;
    }

    trades.push({
      id: tradeCounter++,
      entryTime: new Date(entryBar.t).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }),
      exitTime: new Date(exitBar.t).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }),
      entrySpot: +entrySpot.toFixed(2),
      exitSpot: +exitSpot.toFixed(2),
      spotChangePct: +(((exitSpot - entrySpot) / entrySpot) * 100).toFixed(2),
      entryNetPremium: +entryNetPrem.toFixed(2),
      exitNetPremium: +exitNetPrem.toFixed(2),
      pnl: tradePnl,
      returnPct,
      exitReason,
      durationBars: duration,
      indicatorTrigger: triggerNote || undefined,
    });

    equityCurve.push({
      time: new Date(exitBar.t).toLocaleDateString("en-IN"),
      pnl: tradePnl,
      equity: +currentEquity.toFixed(2),
    });

    // Advance forward
    barIdx += duration + 2;
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? +((wins.length / totalTrades) * 100).toFixed(1) : 0;
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 99.9 : 0;
  const maxProfit = trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : 0;
  const maxLoss = trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : 0;
  const avgPnl = totalTrades > 0 ? +(cumPnl / totalTrades).toFixed(2) : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 1;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 1;
  const riskReward = +(avgWin / avgLoss).toFixed(2);
  const maxDrawdownPct = capitalUsed > 0 ? +((maxDrawdown / capitalUsed) * 100).toFixed(1) : 0;
  const returnOnCapital = capitalUsed > 0 ? +((cumPnl / capitalUsed) * 100).toFixed(2) : 0;

  return {
    underlying,
    strategyName,
    interval,
    totalTrades,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate,
    totalPnl: +cumPnl.toFixed(2),
    maxProfit: +maxProfit.toFixed(2),
    maxLoss: +maxLoss.toFixed(2),
    avgPnl,
    profitFactor,
    maxDrawdown: +maxDrawdown.toFixed(2),
    maxDrawdownPct,
    riskReward,
    capitalUsed: +capitalUsed.toFixed(2),
    returnOnCapital,
    trades,
    equityCurve,
  };
}

/**
 * Generates formatted Excel workbook (.xlsx) for the backtest report
 */
export async function generateBacktestExcel(summary: BacktestSummary): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AlgoDesk India";
  wb.created = new Date();

  const ws = wb.addWorksheet("Backtest Report", {
    properties: { tabColor: { argb: "FF0EA5E9" } },
    views: [{ state: "frozen", ySplit: 2 }],
  });

  const MONEY = "#,##0.00";
  const HEAD = "FF0EA5E9";
  const SECTION = "FF1E3A5F";
  const GREEN = "FF16A34A";
  const RED = "FFDC2626";

  ws.columns = [
    { width: 8 },  // A: #
    { width: 18 }, // B: Entry Time
    { width: 18 }, // C: Exit Time
    { width: 12 }, // D: Entry Spot
    { width: 12 }, // E: Exit Spot
    { width: 11 }, // F: Spot Chg %
    { width: 14 }, // G: Entry Net Prem
    { width: 14 }, // H: Exit Net Prem
    { width: 14 }, // I: Net P&L (₹)
    { width: 12 }, // J: Return %
    { width: 14 }, // K: Exit Reason
    { width: 12 }, // L: Duration Bars
  ];

  // Header Title
  const title = ws.addRow([`AlgoDesk India — Strategy Backtest Report: ${summary.strategyName}`]);
  title.font = { bold: true, size: 14, color: { argb: "FF0EA5E9" } };
  ws.mergeCells(1, 1, 1, 12);

  const sub = ws.addRow([
    `Underlying: ${summary.underlying} · Timeframe: ${summary.interval} · Generated: ${new Date().toLocaleString("en-IN")}`,
  ]);
  sub.font = { size: 9.5, color: { argb: "FF64748B" } };
  ws.mergeCells(2, 1, 2, 12);

  // Section 1: Performance Metrics
  ws.addRow([]);
  const sec1 = ws.addRow(["1 · PERFORMANCE SUMMARY", "Backtested over historical candles"]);
  sec1.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
  for (let i = 1; i <= 12; i++) {
    sec1.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SECTION } };
  }

  const addMetric = (label: string, val: string | number, isMoney = false, isPnl = false) => {
    const r = ws.addRow([label, val]);
    r.getCell(1).font = { bold: true, color: { argb: "FFE2E8F0" } };
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    if (isMoney) r.getCell(2).numFmt = MONEY;
    if (isPnl) {
      const num = Number(val);
      r.getCell(2).font = { bold: true, color: { argb: num >= 0 ? GREEN : RED } };
    }
  };

  addMetric("Total Trades Simulated", summary.totalTrades);
  addMetric("Winning Trades", summary.winningTrades);
  addMetric("Losing Trades", summary.losingTrades);
  addMetric("Win Rate (%)", `${summary.winRate}%`);
  addMetric("Profit Factor", summary.profitFactor);
  addMetric("Total Cumulative P&L (₹)", summary.totalPnl, true, true);
  addMetric("Capital Allocated (₹)", summary.capitalUsed, true);
  addMetric("Return on Capital (%)", `${summary.returnOnCapital}%`, false, true);
  addMetric("Max Drawdown (₹)", summary.maxDrawdown, true);
  addMetric("Max Drawdown (%)", `${summary.maxDrawdownPct}%`);
  addMetric("Risk-Reward Ratio", `1 : ${summary.riskReward}`);
  addMetric("Best Single Trade (₹)", summary.maxProfit, true, true);
  addMetric("Worst Single Trade (₹)", summary.maxLoss, true, true);

  // Section 2: Trades Log
  ws.addRow([]);
  const sec2 = ws.addRow(["2 · DETAILED TRADES LOG", `${summary.trades.length} historical trade executions`]);
  sec2.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
  for (let i = 1; i <= 12; i++) {
    sec2.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SECTION } };
  }

  const th = ws.addRow([
    "#",
    "Entry Time",
    "Exit Time",
    "Entry Spot",
    "Exit Spot",
    "Spot Chg %",
    "Entry Prem (₹)",
    "Exit Prem (₹)",
    "Net P&L (₹)",
    "Return %",
    "Exit Reason",
    "Trigger / Hold",
  ]);
  th.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  th.alignment = { vertical: "middle", horizontal: "center" };
  for (let i = 1; i <= 12; i++) {
    th.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } };
  }

  const tradeStartRow = ws.rowCount + 1;
  for (const t of summary.trades) {
    const r = ws.addRow([
      t.id,
      t.entryTime,
      t.exitTime,
      t.entrySpot,
      t.exitSpot,
      t.spotChangePct,
      t.entryNetPremium,
      t.exitNetPremium,
      t.pnl,
      t.returnPct,
      t.exitReason,
      t.indicatorTrigger ? `${t.indicatorTrigger} (${t.durationBars}b)` : `${t.durationBars} bars`,
    ]);

    r.getCell(4).numFmt = MONEY;
    r.getCell(5).numFmt = MONEY;
    r.getCell(7).numFmt = MONEY;
    r.getCell(8).numFmt = MONEY;
    r.getCell(9).numFmt = MONEY;

    // Color PnL
    r.getCell(9).font = { bold: true, color: { argb: t.pnl >= 0 ? GREEN : RED } };
    r.getCell(11).font = {
      bold: true,
      color: { argb: t.exitReason === "TARGET" ? GREEN : t.exitReason === "STOPLOSS" ? RED : "FF94A3B8" },
    };
  }

  // Total summary row
  if (summary.trades.length > 0) {
    const tradeEndRow = ws.rowCount;
    const totRow = ws.addRow([
      "TOTAL",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      { formula: `SUM(I${tradeStartRow}:I${tradeEndRow})`, result: summary.totalPnl },
      "",
      "",
      "",
    ]);
    totRow.font = { bold: true };
    totRow.getCell(9).numFmt = MONEY;
    totRow.getCell(9).font = { bold: true, color: { argb: summary.totalPnl >= 0 ? GREEN : RED } };
  }

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}
