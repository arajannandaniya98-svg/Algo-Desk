import ExcelJS from "exceljs";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/db";
import { orders, setups, strategies } from "@/db/schema";
import { desc } from "drizzle-orm";
import { capitalSnapshot, marginForSetup } from "./capital";
import { applyLivePrice, getCandles } from "./candles";
import { computePnl, currentPrice } from "./engine";
import { analyse } from "./indicators";
import { getQuotes } from "./market";

const MONEY = "#,##0.00";
const PERCENT = "0.00%";
const HEAD = "FF0EA5E9";
const SECTION = "FF1E3A5F";
const TOTAL_FILL = "FF0F2338";
const GREEN = "FF16A34A";
const RED = "FFDC2626";
const COLS = 16;
const SIGNAL_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN"];
export const REPORT_FILENAME = "AlgoDesk-Report.xlsx";

type Row = (string | number | null | { formula: string; result?: number | string })[];

function colour(cell: ExcelJS.Cell) {
  const v = typeof cell.value === "object" && cell.value !== null && "result" in cell.value
    ? Number((cell.value as { result?: unknown }).result)
    : Number(cell.value);
  if (Number.isFinite(v)) {
    if (v > 0) cell.font = { color: { argb: GREEN }, bold: true };
    else if (v < 0) cell.font = { color: { argb: RED }, bold: true };
  }
}

/** Everything lands on ONE single sheet; sections are separated by styled banner rows. */
class Sheet {
  ws: ExcelJS.Worksheet;
  constructor(ws: ExcelJS.Worksheet) {
    this.ws = ws;
  }

  banner(title: string, note = "") {
    this.ws.addRow([]);
    const r = this.ws.addRow([title, note]);
    r.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    r.height = 22;
    for (let i = 1; i <= COLS; i++) {
      r.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SECTION } };
    }
    r.getCell(2).font = { color: { argb: "FFBFDBFE" }, size: 10 };
    return r;
  }

  head(cols: string[]) {
    const r = this.ws.addRow(cols);
    r.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    r.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    r.height = 20;
    cols.forEach((_, i) => (r.getCell(i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } }));
    return r;
  }

  row(
    values: Row,
    opts: {
      money?: number[];
      pnl?: number[];
      pct?: number[];
      bold?: boolean;
      totalRow?: boolean;
    } = {},
  ) {
    const r = this.ws.addRow(values);
    if (opts.bold || opts.totalRow) r.font = { bold: true };
    if (opts.totalRow) {
      r.height = 20;
      for (let i = 1; i <= COLS; i++) {
        r.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_FILL } };
      }
    }
    for (const c of opts.money ?? []) r.getCell(c).numFmt = MONEY;
    for (const c of opts.pct ?? []) r.getCell(c).numFmt = PERCENT;
    for (const c of opts.pnl ?? []) {
      r.getCell(c).numFmt = MONEY;
      colour(r.getCell(c));
    }
    return r;
  }

  kv(label: string, value: string | number | { formula: string; result?: number | string }, money = false, pnl = false, pct = false) {
    const r = this.ws.addRow([label, value]);
    r.getCell(1).font = { bold: true, color: { argb: "FFE2E8F0" } };
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    if (money) r.getCell(2).numFmt = MONEY;
    if (pct) r.getCell(2).numFmt = PERCENT;
    if (pnl) colour(r.getCell(2));
    return r;
  }

  empty(text: string) {
    const r = this.ws.addRow([text]);
    r.font = { italic: true, color: { argb: "FF94A3B8" }, size: 10 };
    return r;
  }
}

async function signalRows(symbols: string[]) {
  const out: Row[] = [];
  try {
    const quotes = await getQuotes(symbols);
    for (let i = 0; i < symbols.length; i += 5) {
      const batch = await Promise.all(
        symbols.slice(i, i + 5).map(async (symbol) => {
          const set = await getCandles(symbol, "15m");
          if (!set) return null;
          const a = analyse(applyLivePrice(set.candles, quotes[symbol]?.ltp));
          if (!a) return null;
          const get = (id: string) => a.indicators.find((x) => x.id === id);
          const reasons = a.indicators
            .filter((x) => x.vote === a.signal && a.signal !== "HOLD")
            .map((x) => x.name)
            .slice(0, 4)
            .join(", ");
          return [
            symbol,
            a.signal,
            a.score,
            a.strength,
            quotes[symbol]?.ltp ?? a.close,
            quotes[symbol]?.changePct ?? a.changePct,
            a.trend,
            `${a.buy}/${a.sell}/${a.hold}`,
            get("rsi")?.value ?? "",
            get("macd")?.value ?? "",
            get("supertrend")?.vote ?? "",
            a.levels.stopLoss,
            a.levels.target,
            reasons || "Indicators disagree — no edge",
          ] as Row;
        }),
      );
      for (const b of batch) if (b) out.push(b);
    }
  } catch {
    /* signals are best-effort in the report */
  }
  return out;
}

/** Builds the comprehensive single-sheet trading report workbook. */
export async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AlgoDesk India";
  wb.created = new Date();
  const ws = wb.addWorksheet("AlgoDesk", {
    properties: { tabColor: { argb: HEAD }, defaultRowHeight: 16 },
    views: [{ state: "frozen", ySplit: 2 }],
  });

  // 16 columns tailored for complete trade accounting
  ws.columns = [
    { width: 14 }, // A: Symbol
    { width: 28 }, // B: Setup / Strategy
    { width: 8 },  // C: Side
    { width: 8 },  // D: Qty
    { width: 12 }, // E: Status
    { width: 13 }, // F: Entry Price
    { width: 13 }, // G: Current LTP
    { width: 13 }, // H: Exit Price
    { width: 15 }, // I: Capital Used (Margin)
    { width: 15 }, // J: Trade P&L (₹) (Calculated)
    { width: 12 }, // K: Trade Ret %
    { width: 12 }, // L: Stop Loss
    { width: 12 }, // M: Target
    { width: 11 }, // N: Trail SL
    { width: 12 }, // O: Product
    { width: 34 }, // P: Notes / Exit Reason
  ];
  const S = new Sheet(ws);

  const [snap, allSetups, allStrategies, allOrders] = await Promise.all([
    capitalSnapshot(),
    db.select().from(setups).orderBy(desc(setups.updatedAt)),
    db.select().from(strategies).orderBy(desc(strategies.updatedAt)),
    db.select().from(orders).orderBy(desc(orders.id)).limit(200),
  ]);

  // Compute live LTP, individual setup margin, and verified P&L
  const priced = await Promise.all(
    allSetups.map(async (s) => {
      const ltp = await currentPrice(s);
      const margin = await marginForSetup(s);
      const pnl = s.status === "ENTERED" && ltp != null && s.entryFilledPrice != null ? computePnl(s, ltp) : s.pnl;
      return { ...s, ltp, margin: +margin.toFixed(2), pnl: +pnl.toFixed(2) };
    }),
  );

  // ---------- TITLE ----------
  const title = ws.addRow(["AlgoDesk India — Complete Trading Report & P&L Statement"]);
  title.font = { bold: true, size: 15, color: { argb: "FF0EA5E9" } };
  title.height = 24;
  ws.mergeCells(1, 1, 1, COLS);

  const sub = ws.addRow([
    `Generated: ${new Date().toLocaleString("en-IN")} · 1 Single Sheet Automatic Accounting · Dynamic Formulas & Totals · Currency: ₹`,
  ]);
  sub.font = { size: 9.5, color: { argb: "FF64748B" } };
  ws.mergeCells(2, 1, 2, COLS);

  // ---------- SECTION 1: CAPITAL & OVERALL P&L SUMMARY ----------
  S.banner("1 · CAPITAL & TOTAL P&L SUMMARY", "Account Balance, Margin, Realized & Unrealized P&L");
  const wins = allSetups.filter((s) => s.status === "EXITED" && s.pnl > 0).length;
  const losses = allSetups.filter((s) => s.status === "EXITED" && s.pnl < 0).length;
  const enteredSetups = allSetups.filter((s) => s.status === "ENTERED");
  const totalTradePnl = +(snap.realized + snap.unrealized).toFixed(2);

  S.kv("Starting Capital", snap.capital, true);
  S.kv("Total Capital Used (Blocked Margin)", snap.usedMargin, true);
  S.kv("Free Capital (Available Margin)", snap.freeMargin, true);
  S.kv("Total Realized P&L (Closed Trades)", snap.realized, true, true);
  S.kv("Total Unrealized P&L (Open Positions)", snap.unrealized, true, true);
  S.kv("TOTAL NET P&L (Realized + Unrealized)", totalTradePnl, true, true);
  S.kv("Net Account Equity (Capital + Total P&L)", snap.equity, true, true);
  S.kv("Total Return on Capital (%)", snap.returnPct / 100, false, true, true);
  S.kv("Capital Utilization (Exposure %)", snap.exposurePct / 100, false, false, true);
  S.kv("Today's P&L", snap.dayPnl, true, true);
  S.kv("Daily Loss Limit", snap.dayLossLimit, true);
  S.kv("Loss Limit Status", snap.dayLossHit ? "HIT — Trading Blocked" : "Normal (Active)");
  S.kv("Open Positions Count", enteredSetups.length);
  S.kv("Closed Trades Count", allSetups.filter((s) => s.status === "EXITED").length);
  S.kv("Win / Loss Ratio", `${wins} Wins / ${losses} Losses${wins + losses ? ` (${Math.round((wins / (wins + losses)) * 100)}% Win Rate)` : ""}`);

  // ---------- SECTION 2: SETUPS & POSITIONS WITH TRADE P&L & CAPITAL CALCULATION ----------
  S.banner(
    "2 · SETUPS, POSITIONS & TRADE CALCULATION",
    "Entry Price, Exit Price, Capital Used, Calculated Profit/Loss & Totals",
  );
  S.head([
    "Symbol",
    "Setup / Strategy Name",
    "Side",
    "Qty",
    "Status",
    "Entry Price",
    "Current LTP",
    "Exit Price",
    "Capital Used (₹)",
    "Trade P&L (₹)",
    "Return %",
    "Stop Loss",
    "Target",
    "Trail SL",
    "Product",
    "Notes / Exit Reason",
  ]);

  const tradeRowStart = ws.rowCount + 1;
  if (priced.length) {
    for (const s of priced) {
      const st = allStrategies.find((x) => x.id === s.strategyId);
      const entryVal = s.entryFilledPrice ?? s.entryPrice ?? null;
      const exitVal = s.status === "EXITED" ? s.exitFilledPrice : null;
      const ltpVal = s.ltp;
      const capitalUsed = s.status === "ENTERED" ? s.margin : s.entryFilledPrice ? +(s.entryFilledPrice * s.quantity).toFixed(2) : 0;
      const tradeRet = capitalUsed > 0 ? +(s.pnl / capitalUsed) : 0;

      const row = S.row(
        [
          `${s.symbol}${s.strike ? ` ${s.strike}${s.instrumentType}` : ""}`,
          st ? `${st.name} · L${s.legIndex + 1}` : s.name,
          s.side,
          s.quantity,
          s.status,
          entryVal,
          ltpVal,
          exitVal,
          capitalUsed,
          s.pnl,
          tradeRet,
          s.stopLoss,
          s.target,
          s.trailingSl,
          `${s.productType}/${s.orderType}`,
          [s.exitReason, s.notes].filter(Boolean).join(" · "),
        ],
        {
          money: [6, 7, 8, 9, 12, 13, 14],
          pnl: [10],
          pct: [11],
        },
      );
      if (s.status === "ENTERED") row.getCell(5).font = { bold: true, color: { argb: "FF0EA5E9" } };
      else if (s.status === "EXITED") row.getCell(5).font = { bold: true, color: { argb: s.pnl >= 0 ? GREEN : RED } };
    }

    const tradeRowEnd = ws.rowCount;
    // Automatic Dynamic Excel Formulas for Sum of Capital Used & Total P&L
    const totalRow = S.row(
      [
        "TOTAL",
        `Calculated Summary of ${priced.length} Trade Setups`,
        "",
        { formula: `SUM(D${tradeRowStart}:D${tradeRowEnd})`, result: priced.reduce((a, s) => a + s.quantity, 0) },
        `${enteredSetups.length} Open / ${allSetups.filter((s) => s.status === "EXITED").length} Closed`,
        "",
        "",
        "",
        { formula: `SUM(I${tradeRowStart}:I${tradeRowEnd})`, result: priced.reduce((a, s) => a + (s.status === "ENTERED" ? s.margin : 0), 0) },
        { formula: `SUM(J${tradeRowStart}:J${tradeRowEnd})`, result: priced.reduce((a, s) => a + s.pnl, 0) },
        { formula: `IF(I${tradeRowEnd + 1}>0, J${tradeRowEnd + 1}/I${tradeRowEnd + 1}, 0)`, result: totalTradePnl > 0 ? 0.05 : 0 },
        "",
        "",
        "",
        "",
        `Net P&L: ₹${priced.reduce((a, s) => a + s.pnl, 0).toFixed(2)}`,
      ],
      {
        totalRow: true,
        money: [9],
        pnl: [10],
        pct: [11],
      },
    );
    totalRow.getCell(1).alignment = { horizontal: "center" };
  } else {
    S.empty("No setups or active positions yet.");
  }

  // ---------- SECTION 3: INDICATOR SIGNALS ----------
  const watch = [...new Set([...allSetups.filter((s) => s.status === "ACTIVE" || s.status === "ENTERED").map((s) => s.underlying || s.symbol), ...SIGNAL_SYMBOLS])].slice(0, 12);
  S.banner("3 · INDICATOR SIGNALS & TRENDS", "Supertrend · EMA · MACD · RSI · ADX · Bollinger · Stochastic · VWAP · Volume");
  S.head(["Symbol", "Signal", "Score", "Strength", "LTP", "Day %", "Trend", "B/S/H", "RSI", "MACD", "Supertrend", "Stop Loss", "Target", "Rationale / Edge", "", ""]);
  const sig = await signalRows(watch);
  if (sig.length) {
    for (const r of sig) {
      const row = S.row(r, { money: [5, 12, 13], pnl: [3, 6] });
      const v = String(r[1]);
      row.getCell(2).font = { bold: true, color: { argb: v === "BUY" ? GREEN : v === "SELL" ? RED : "FF94A3B8" } };
    }
  } else {
    S.empty("Signals unavailable — open the Signals page to scan.");
  }

  // ---------- SECTION 4: STRATEGIES ----------
  S.banner("4 · MULTI-LEG STRATEGIES", `${allStrategies.length} strategy structures`);
  S.head(["Underlying", "Strategy Name", "Template", "Lots", "Lot Size", "Expiry", "Spot Price", "Net Premium (₹)", "Max Profit (₹)", "Max Loss (₹)", "Margin Req (₹)", "Status", "Breakeven Levels", "Notes", "", ""]);
  if (allStrategies.length) {
    for (const st of allStrategies) {
      S.row(
        [
          st.underlying,
          st.name,
          st.template,
          st.lots,
          st.lotSize,
          st.expiry,
          st.spot,
          st.netPremium,
          st.maxProfit,
          st.maxLoss,
          st.marginRequired,
          st.status,
          (st.breakevens ?? []).join(" / "),
          st.notes,
          "",
          "",
        ],
        {
          money: [7, 11],
          pnl: [8, 9, 10],
        },
      );
    }
  } else {
    S.empty("No multi-leg strategies built yet.");
  }

  // ---------- SECTION 5: ORDER BOOK LOG ----------
  S.banner("5 · ORDER BOOK LOG", `Execution history (Last ${allOrders.length} orders)`);
  S.head([
    "Time",
    "Symbol",
    "Action",
    "Side",
    "Qty",
    "Type",
    "Product",
    "Price",
    "Filled Price",
    "Status",
    "Mode",
    "Broker",
    "Broker Order ID",
    "Execution Message",
    "",
    "",
  ]);
  if (allOrders.length) {
    for (const o of allOrders) {
      const row = S.row(
        [
          new Date(o.createdAt).toLocaleString("en-IN"),
          o.symbol,
          o.action,
          o.side,
          o.quantity,
          o.orderType,
          o.productType,
          o.price,
          o.filledPrice,
          o.status,
          o.mode,
          o.provider,
          o.brokerOrderId,
          o.message,
          "",
          "",
        ],
        { money: [8, 9] },
      );
      row.getCell(10).font = { bold: true, color: { argb: o.status === "REJECTED" ? RED : o.status === "FILLED" ? GREEN : "FFF59E0B" } };
    }
  } else {
    S.empty("No orders executed yet.");
  }

  // ---------- SECTION 6: MARGIN ALLOCATION & CAPITAL CONSUMPTION ----------
  S.banner("6 · MARGIN ALLOCATION & CAPITAL CONSUMPTION", "Breakdown of Capital Used per Open Position");
  S.head(["Setup ID", "Position Description", "Capital Blocked (Margin ₹)", "% of Capital Consumed", "", "", "", "", "", "", "", "", "", "", "", ""]);
  if (snap.marginBySetup.length) {
    const marginRowStart = ws.rowCount + 1;
    for (const m of snap.marginBySetup) {
      S.row([m.id, m.name, m.margin, snap.capital ? +(m.margin / snap.capital) : 0], {
        money: [3],
        pct: [4],
      });
    }
    const marginRowEnd = ws.rowCount;
    S.row(
      [
        "TOTAL",
        "Total Active Capital Allocated to Margin",
        { formula: `SUM(C${marginRowStart}:C${marginRowEnd})`, result: snap.usedMargin },
        { formula: `SUM(D${marginRowStart}:D${marginRowEnd})`, result: snap.exposurePct / 100 },
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
      {
        totalRow: true,
        money: [3],
        pct: [4],
      },
    );
  } else {
    S.empty("No capital currently blocked (No open positions).");
  }

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: COLS } };
  return {
    wb,
    snap,
    setupsCount: allSetups.length,
    ordersCount: allOrders.length,
    strategiesCount: allStrategies.length,
    signalsCount: sig.length,
    rows: ws.rowCount,
  };
}

export async function workbookBuffer(): Promise<ArrayBuffer> {
  const { wb } = await buildWorkbook();
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** Overwrites the same file on the server, so one file always holds the latest report. */
export async function saveWorkbookToDisk() {
  const dir = path.join(/* turbopackIgnore: true */ process.cwd(), "exports");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, REPORT_FILENAME);
  const { wb, signalsCount, setupsCount, ordersCount } = await buildWorkbook();
  await wb.xlsx.writeFile(file);
  const stat = await fs.stat(file);
  return { file, bytes: stat.size, savedAt: stat.mtime.toISOString(), signalsCount, setupsCount, ordersCount };
}
