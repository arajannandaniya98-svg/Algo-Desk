"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Setup } from "@/db/schema";
import { api, fmt } from "./utils";
import { toast } from "./Toast";
import { useLiveTicks } from "./useLiveTicks";
import { SetupForm, type SetupDraft } from "./SetupForm";

import {
  type Candle,
  type IndicatorConfig,
  DEFAULT_INDICATOR_CONFIG,
} from "@/lib/indicators";
import { evaluateFormula } from "@/lib/custom-indicator";
import { TradingViewCanvasChart } from "./TradingViewCanvasChart";

type Vote = "BUY" | "SELL" | "HOLD";
type Indicator = { id: string; name: string; value: string; vote: Vote; weight: number; detail: string };
type SmcZone = { type: "OB+" | "OB-" | "FVG+" | "FVG-"; top: number; bottom: number; t: number; touched: boolean };
type Smc = {
  swings: { t: number; price: number; kind: string }[];
  breaks: { kind: "BOS" | "CHoCH"; dir: "UP" | "DOWN"; level: number; t: number; swingT: number }[];
  zones: SmcZone[];
  equilibrium: { high: number; low: number; eq: number; pricePosition: string };
  liquidity: { level: number; side: string; count: number }[];
  plan: {
    bias: string;
    action: "BUY" | "SELL" | "WAIT";
    entry: number;
    stopLoss: number;
    target1: number;
    target2: number;
    riskReward: number;
    zone: string;
    reason: string;
    inZone: boolean;
  };
  trend: string;
};

type ChartMeta = {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  lotSize: number;
  interval: string;
  source: string;
  quote?: { ltp: number; changePct: number; source?: string; provider?: string };
  candles?: Candle[];
  signal: {
    signal: Vote;
    strength: string;
    score: number;
    buy: number;
    sell: number;
    hold: number;
    indicators: Indicator[];
    levels: { atr: number; stopLoss: number; target: number; support: number; resistance: number; riskReward: number };
    trend: string;
    rsiCrossover?: {
      type: string;
      signal: Vote;
      detail: string;
      prevRsi: number;
      currRsi: number;
    };
  } | null;
  smc: Smc | null;
};

type QuickSig = { symbol: string; signal: Vote; score: number };

const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "RELIANCE", "HDFCBANK", "TCS", "BTCUSD", "ETHUSD"];
const VOTE_CLS: Record<Vote, string> = {
  BUY: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  SELL: "bg-red-500/20 text-red-300 border-red-500/40",
  HOLD: "bg-slate-600/30 text-slate-300 border-slate-500/40",
};
const DOT: Record<Vote, string> = { BUY: "bg-emerald-500", SELL: "bg-red-500", HOLD: "bg-slate-500" };

const TV_INTERVAL_MAP: Record<string, string> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "60m": "60",
  "1d": "D",
};

const HEIGHT_MAP = { compact: 420, normal: 520, large: 620, xl: 760 };

export function TradingChart() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [interval, setIntervalId] = useState("15m");
  const [data, setData] = useState<ChartMeta | null>(null);
  const [quick, setQuick] = useState<QuickSig[]>([]);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [sizePreset, setSizePreset] = useState<"compact" | "normal" | "large" | "xl">("large");
  const [fullscreen, setFullscreen] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(true);

  // Indicator Manual Configuration
  const [indConfig, setIndConfig] = useState<IndicatorConfig>(DEFAULT_INDICATOR_CONFIG);
  const [showIndModal, setShowIndModal] = useState(false);
  const [customPineIndicators, setCustomPineIndicators] = useState<{
    id: string;
    name: string;
    formula: string;
    color: string;
    lineWidth: number;
    enabled: boolean;
  }[]>([]);
  const [pinePreviewError, setPinePreviewError] = useState<string>("");

  // Auto-Trade state
  const [autoTradeConfig, setAutoTradeConfig] = useState<{
    enabled: boolean;
    symbols: string[];
    interval: string;
    maxPositions: number;
    minScore: number;
    defaultLots: number;
  }>({
    enabled: false,
    symbols: ["NIFTY", "BANKNIFTY", "RELIANCE", "BTCUSD"],
    interval: "15m",
    maxPositions: 3,
    minScore: 40,
    defaultLots: 1,
  });
  const [showAutoTradeModal, setShowAutoTradeModal] = useState(false);

  // Manual Chart Segments (add/remove symbols below timeframe)
  const [chartSymbols, setChartSymbols] = useState<string[]>(QUICK);
  const [newChartSymbol, setNewChartSymbol] = useState("");

  // Setups & Active Positions on this symbol
  const [allSetups, setAllSetups] = useState<Setup[]>([]);
  const [updatingTrade, setUpdatingTrade] = useState(false);
  const [tradeSlInput, setTradeSlInput] = useState("");
  const [tradeTgtInput, setTradeTgtInput] = useState("");
  const [tradeTrailInput, setTradeTrailInput] = useState("");

  // Load saved preferences
  useEffect(() => {
    const saved = localStorage.getItem("algodesk.chartSymbol");
    if (saved && /^[A-Z0-9&_.|-]{1,40}$/.test(saved)) setSymbol(saved);
    const iv = localStorage.getItem("algodesk.chartInterval");
    if (iv) setIntervalId(iv);
    const sz = localStorage.getItem("algodesk.chartSize") as "compact" | "normal" | "large" | "xl" | null;
    if (sz && ["compact", "normal", "large", "xl"].includes(sz)) setSizePreset(sz);
    try {
      const segs = JSON.parse(localStorage.getItem("algodesk.chartSegments") ?? "null");
      if (Array.isArray(segs) && segs.length > 0) setChartSymbols(segs);
    } catch {
      // default QUICK
    }

    try {
      const savedInd = JSON.parse(localStorage.getItem("algodesk.indConfig") ?? "null");
      if (savedInd) setIndConfig((prev) => ({ ...prev, ...savedInd }));
      const pine = JSON.parse(localStorage.getItem("algodesk.pineIndicators") ?? "[]");
      if (Array.isArray(pine)) setCustomPineIndicators(pine);
    } catch {
      // ignore
    }

    const onOpenChart = (e: Event) => {
      const d = (e as CustomEvent).detail as { symbol?: string };
      if (d?.symbol) {
        setSymbol(d.symbol);
        localStorage.setItem("algodesk.chartSymbol", d.symbol);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("algodesk-open-chart", onOpenChart);
    return () => window.removeEventListener("algodesk-open-chart", onOpenChart);
  }, []);

  // Fetch setups & auto-trade settings
  const loadSetupsAndAutoTrade = useCallback(() => {
    api<Setup[]>("/api/setups")
      .then((res) => setAllSetups(res))
      .catch(() => {});
    api<{ autoTrade: typeof autoTradeConfig; indicatorConfig: Partial<IndicatorConfig> }>("/api/autotrade")
      .then((res) => {
        if (res.autoTrade) setAutoTradeConfig(res.autoTrade);
        if (res.indicatorConfig && Object.keys(res.indicatorConfig).length > 0) {
          setIndConfig((prev) => ({ ...prev, ...(res.indicatorConfig as any) }));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSetupsAndAutoTrade();
    const id = setInterval(loadSetupsAndAutoTrade, 5000);
    window.addEventListener("engine-tick", loadSetupsAndAutoTrade);
    return () => {
      clearInterval(id);
      window.removeEventListener("engine-tick", loadSetupsAndAutoTrade);
    };
  }, [loadSetupsAndAutoTrade]);

  // Load candle data with custom indicator configuration
  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({
        symbol,
        interval,
        ind_st_p: String(indConfig.supertrendPeriod),
        ind_st_m: String(indConfig.supertrendMult),
        ind_ema_f: String(indConfig.emaFast),
        ind_ema_s: String(indConfig.emaSlow),
        ind_macd_f: String(indConfig.macdFast),
        ind_macd_s: String(indConfig.macdSlow),
        ind_macd_sig: String(indConfig.macdSignal),
        ind_rsi_p: String(indConfig.rsiPeriod),
        ind_rsi_ob: String(indConfig.rsiOverbought),
        ind_rsi_os: String(indConfig.rsiOversold),
        ind_adx_p: String(indConfig.adxPeriod),
        ind_adx_th: String(indConfig.adxThreshold),
        ind_bb_p: String(indConfig.bollingerPeriod),
        ind_bb_m: String(indConfig.bollingerMult),
        ind_stoch_p: String(indConfig.stochPeriod),
        ind_stoch_s: String(indConfig.stochSmooth),
        ind_ema50_p: String(indConfig.ema50Period),
        ind_vol_p: String(indConfig.volumePeriod),
      });
      const res = await api<ChartMeta>(`/api/candles?${qs.toString()}`);
      setData(res);
    } catch {
      // quiet fallback
    }
  }, [symbol, interval, indConfig]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const loadQuick = () => {
      const syms = chartSymbols.slice(0, 40).join(",");
      if (!syms) return;
      api<{ items: { symbol: string; signal: Vote; score: number }[] }>(
        `/api/signals?interval=${interval === "1m" || interval === "3m" ? "5m" : interval}&symbols=${syms}`
      )
        .then((r) => setQuick(r.items.map((i) => ({ symbol: i.symbol, signal: i.signal, score: i.score }))))
        .catch(() => {});
    };
    loadQuick();
    const id = setInterval(loadQuick, 60000);
    return () => clearInterval(id);
  }, [interval, chartSymbols]);

  const { ticks } = useLiveTicks([symbol]);
  const live = ticks[symbol];

  // Merge live tick into last candle close
  const candles = useMemo(() => {
    const base = data?.candles ?? [];
    if (!base.length || !live?.ltp) return base;
    const out = base.slice();
    const lastBar = { ...out[out.length - 1] };
    lastBar.c = live.ltp;
    lastBar.h = Math.max(lastBar.h, live.ltp);
    lastBar.l = Math.min(lastBar.l, live.ltp);
    out[out.length - 1] = lastBar;
    return out;
  }, [data?.candles, live?.ltp]);

  const sig = data?.signal ?? null;
  const smc = data?.smc ?? null;
  const plan = smc?.plan ?? null;
  const ltp = live?.ltp ?? data?.quote?.ltp ?? 0;
  const chgPct = live?.changePct ?? data?.quote?.changePct ?? 0;
  const isCrypto = data?.exchange === "DELTA" || symbol.endsWith("USD");
  const curSym = isCrypto ? "$" : "₹";

  const chartHeight = HEIGHT_MAP[sizePreset];

  // Active trade on this symbol
  const activeTrade = useMemo(() => {
    return allSetups.find(
      (s) => s.status === "ENTERED" && (s.symbol === symbol || s.underlying === symbol)
    );
  }, [allSetups, symbol]);

  // Sync inputs when activeTrade changes
  useEffect(() => {
    if (activeTrade) {
      setTradeSlInput(activeTrade.stopLoss ? String(activeTrade.stopLoss) : "");
      setTradeTgtInput(activeTrade.target ? String(activeTrade.target) : "");
      setTradeTrailInput(activeTrade.trailingSl ? String(activeTrade.trailingSl) : "");
    }
  }, [activeTrade]);

  // Calculate Trade P&L
  const activeTradePnl = useMemo(() => {
    if (!activeTrade || !activeTrade.entryFilledPrice || !ltp) return 0;
    const dir = activeTrade.side === "BUY" ? 1 : -1;
    let mult = 1;
    if (activeTrade.exchange === "DELTA") {
      const m = (activeTrade.meta ?? {}) as { ctv?: number; fx?: number };
      mult = (m.ctv && m.ctv > 0 ? m.ctv : symbol.includes("BTC") ? 0.001 : 0.01) * (m.fx && m.fx > 0 ? m.fx : 88);
    }
    return +((ltp - activeTrade.entryFilledPrice) * dir * activeTrade.quantity * mult).toFixed(2);
  }, [activeTrade, ltp, symbol]);

  const updateTradeLevels = async () => {
    if (!activeTrade) return;
    setUpdatingTrade(true);
    try {
      await api(`/api/setups/${activeTrade.id}`, {
        method: "PUT",
        body: JSON.stringify({
          stopLoss: tradeSlInput ? Number(tradeSlInput) : null,
          target: tradeTgtInput ? Number(tradeTgtInput) : null,
          trailingSl: tradeTrailInput ? Number(tradeTrailInput) : null,
        }),
      });
      toast(`Updated SL: ₹${tradeSlInput || "none"} · Tgt: ₹${tradeTgtInput || "none"}`, "success");
      loadSetupsAndAutoTrade();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setUpdatingTrade(false);
    }
  };

  const exitActiveTrade = async () => {
    if (!activeTrade) return;
    if (!confirm(`Square-off / EXIT position in ${activeTrade.symbol}?`)) return;
    try {
      const res = await api<{ ok: boolean; message: string; pnl?: number }>(`/api/setups/${activeTrade.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "exit" }),
      });
      toast(res.message, res.ok ? "success" : "error");
      loadSetupsAndAutoTrade();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const pickSymbol = (s: string) => {
    setSymbol(s);
    localStorage.setItem("algodesk.chartSymbol", s);
  };

  const pickInterval = (iv: string) => {
    setIntervalId(iv);
    localStorage.setItem("algodesk.chartInterval", iv);
  };

  const setSize = (sz: "compact" | "normal" | "large" | "xl") => {
    setSizePreset(sz);
    localStorage.setItem("algodesk.chartSize", sz);
  };

  const savePineIndicators = (arr: typeof customPineIndicators) => {
    setCustomPineIndicators(arr);
    localStorage.setItem("algodesk.pineIndicators", JSON.stringify(arr));
  };

  // Manual chart segment symbol add/remove (persisted)
  const addChartSymbol = async () => {
    const s = newChartSymbol.trim().toUpperCase();
    if (!s || !/^[A-Z0-9&_.|-]{1,40}$/.test(s)) {
      toast("Enter a valid symbol (A-Z 0-9)", "error");
      return;
    }
    if (chartSymbols.includes(s)) {
      toast(`${s} already in chart segments`, "info");
      setNewChartSymbol("");
      return;
    }
    const next = [...chartSymbols, s];
    setChartSymbols(next);
    localStorage.setItem("algodesk.chartSegments", JSON.stringify(next));
    setNewChartSymbol("");
    try {
      const r = await api<{ items: { symbol: string; name: string }[] }>(`/api/instruments?q=${encodeURIComponent(s)}&limit=10`);
      if (!r.items.some((i) => i.symbol === s)) {
        toast(`${s} added locally — not found in instrument master, but will render on TradingView-style engine`, "info");
      } else {
        toast(`${s} added to chart segments ✓`, "success");
      }
    } catch {
      toast(`${s} added to chart segments ✓`, "success");
    }
  };

  const removeChartSymbol = (s: string) => {
    const next = chartSymbols.filter((x) => x !== s);
    setChartSymbols(next);
    localStorage.setItem("algodesk.chartSegments", JSON.stringify(next));
    if (symbol === s && next.length) pickSymbol(next[0]);
  };

  const doSearch = async () => {
    const s = search.trim().toUpperCase();
    if (!s) return;
    try {
      const r = await api<{ items: { symbol: string }[] }>(`/api/instruments?q=${encodeURIComponent(s)}&limit=20`);
      if (!r.items.some((i) => i.symbol === s)) {
        toast(`Switching to ${s} on TradingView`, "info");
      }
      pickSymbol(s);
      setSearch("");
    } catch {
      pickSymbol(s);
      setSearch("");
    }
  };

  const trade = (side: "BUY" | "SELL") => {
    if (!data) return;
    const isIndex = data.segment === "INDEX";
    setDraft({
      name: `${data.symbol} ${side}${sig ? ` · ${sig.signal} signal (${interval})` : ""}`,
      symbol: data.symbol,
      underlying: isIndex || isCrypto ? data.symbol : "",
      exchange: isCrypto ? "DELTA" : data.exchange || "NSE",
      segment: isCrypto ? "CRYPTO" : isIndex ? "FUT" : data.segment || "EQ",
      instrumentType: isIndex || isCrypto ? "FUT" : "EQ",
      side,
      quantity: isIndex ? data.lotSize : 1,
      productType: isIndex || isCrypto ? "NRML" : "MIS",
      orderType: "MARKET",
      entryPrice: ltp,
      stopLoss: sig?.levels.stopLoss,
      target: sig?.levels.target,
      notes: sig
        ? `TradingView Chart Entry · ${sig.signal} score ${sig.score} · SL/Target from ATR ${sig.levels.atr}`
        : "TradingView Chart Entry",
    });
  };

  const toggleAutoTradeSymbol = async () => {
    const currentSymbols = autoTradeConfig.symbols ?? [];
    const isWatched = currentSymbols.includes(symbol);
    const updatedSymbols = isWatched
      ? currentSymbols.filter((s) => s !== symbol)
      : [...currentSymbols, symbol];

    try {
      const res = await api<{ ok: boolean; autoTrade: typeof autoTradeConfig }>("/api/autotrade", {
        method: "PUT",
        body: JSON.stringify({
          autoTrade: {
            ...autoTradeConfig,
            symbols: updatedSymbols,
          },
        }),
      });
      if (res.autoTrade) setAutoTradeConfig(res.autoTrade);
      toast(
        isWatched
          ? `Removed ${symbol} from Auto-Trade list`
          : `Added ${symbol} to Auto-Trade list! (Total: ${updatedSymbols.length})`,
        "success"
      );
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const toggleAutoTradeGlobal = async () => {
    const nextState = !autoTradeConfig.enabled;
    try {
      const res = await api<{ ok: boolean; autoTrade: typeof autoTradeConfig }>("/api/autotrade", {
        method: "PUT",
        body: JSON.stringify({
          autoTrade: {
            ...autoTradeConfig,
            enabled: nextState,
          },
        }),
      });
      if (res.autoTrade) setAutoTradeConfig(res.autoTrade);
      toast(
        nextState
          ? "🤖 Auto-Trade BOT is now ACTIVE! Trades will execute on indicator signals."
          : "🤖 Auto-Trade BOT is paused.",
        nextState ? "success" : "info"
      );
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const saveManualIndicators = async (newCfg: IndicatorConfig) => {
    setIndConfig(newCfg);
    localStorage.setItem("algodesk.indConfig", JSON.stringify(newCfg));
    try {
      await api("/api/autotrade", {
        method: "PUT",
        body: JSON.stringify({ indicatorConfig: newCfg }),
      });
      toast("Indicator parameters updated & applied across platform!", "success");
      setShowIndModal(false);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const symbolAutoTraded = (autoTradeConfig.symbols ?? []).includes(symbol);

  // Compute levels for chart
  const chartLevels = useMemo(() => {
    if (activeTrade) {
      return {
        entry: activeTrade.entryFilledPrice || activeTrade.entryPrice || undefined,
        stopLoss: activeTrade.stopLoss || undefined,
        target: activeTrade.target || undefined,
        trailingSl:
          (activeTrade.meta as any)?.trailSl || activeTrade.trailingSl || undefined,
        tradeSide: activeTrade.side,
        tradeQty: activeTrade.quantity,
        support: sig?.levels.support,
        resistance: sig?.levels.resistance,
      };
    }
    if (sig?.levels) {
      return {
        stopLoss: sig.levels.stopLoss,
        target: sig.levels.target,
        support: sig.levels.support,
        resistance: sig.levels.resistance,
        entry: plan?.entry,
      };
    }
    return null;
  }, [activeTrade, sig, plan]);

  return (
    <div
      className={`panel overflow-hidden transition-all duration-150 ${
        fullscreen ? "fixed inset-2 z-50 bg-[#0b0f17] flex flex-col shadow-2xl border-sky-500/50" : ""
      }`}
    >
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-2 border-b border-[#1f2937]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono font-black text-xl text-white">{symbol}</span>

            {/* Direct Option Chain Button */}
            <Link
              href={`/options?u=${symbol}`}
              className="btn btn-xs bg-purple-500/20 text-purple-300 border-purple-500/30 hover:bg-purple-500/30 font-bold flex items-center gap-1"
              title={`Open live Option Chain for ${symbol}`}
            >
              ⛓ Option Chain
            </Link>


            {ltp > 0 && (
              <span
                key={live?.flashAt}
                className={`mono text-lg font-bold px-1.5 py-0.5 rounded ${
                  live?.flashAt ? (live.dir === "up" ? "flash-up" : "flash-down") : "text-white"
                }`}
              >
                {curSym}
                {fmt(ltp)}
              </span>
            )}

            <span className={`mono text-xs font-semibold ${chgPct >= 0 ? "up" : "down"}`}>
              {chgPct >= 0 ? "▲ +" : "▼ "}
              {fmt(chgPct)}%
            </span>

            {sig && (
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-black ${VOTE_CLS[sig.signal]}`}>
                Signal: {sig.signal} {sig.score > 0 ? `+${sig.score}` : sig.score}
              </span>
            )}
            {sig?.rsiCrossover && sig.rsiCrossover.type !== "NONE" && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${
                  sig.rsiCrossover.signal === "BUY"
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                    : "bg-red-500/20 text-red-300 border-red-500/40"
                }`}
                title={sig.rsiCrossover.detail}
              >
                RSI CROSS {sig.rsiCrossover.signal}
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-2">
            <span>Advanced Chart Engine · Real-Time Market Data · Stable Canvas Rendering · Direct SL/Target Order Execution</span>
          </div>
        </div>

        {/* Timeframes, Auto-Trade Bot & Search */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div>
            <label className="label text-[9px] mb-0.5">Time Frame</label>
            <select
              className="input mono w-28 py-1 text-xs font-bold"
              value={interval}
              onChange={(e) => pickInterval(e.target.value)}
              title="1-click timeframe switch"
            >
              <option value="1m">1 Minute</option>
              <option value="3m">3 Minute</option>
              <option value="5m">5 Minute</option>
              <option value="15m">15 Minute</option>
              <option value="30m">30 Minute</option>
              <option value="60m">1 Hour</option>
              <option value="1d">1 Day</option>
            </select>
          </div>

          {/* Manual Indicators Configuration Button */}
          <button
            className="btn btn-xs bg-[#172338] hover:bg-[#20314d] text-sky-300 border-sky-500/30 font-bold"
            onClick={() => setShowIndModal(true)}
            title="Configure all indicators manually + custom pine-style formulas"
          >
            ⚙️ Setup Indicators / Pine
          </button>

          {/* Auto-Trade Bot Toggle */}
          <button
            className={`btn btn-xs font-bold border ${
              autoTradeConfig.enabled
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50 animate-pulse"
                : "bg-[#172338] text-slate-400 border-slate-700"
            }`}
            onClick={() => setShowAutoTradeModal(true)}
            title="Auto-Trade Bot on Indicator Signals"
          >
            🤖 Auto-Trade: {autoTradeConfig.enabled ? "ON" : "OFF"}
          </button>

          <div className="flex items-center gap-1 ml-1">
            <input
              className="input mono w-24 text-xs py-1"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
            />
            <button className="btn btn-xs" onClick={doSearch}>
              Go
            </button>
          </div>
        </div>
      </div>

      {/* Toolbar: Manual Chart Segments + Chart Size Controls */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 px-3 py-1.5 border-b border-[#1f2937] bg-[#0c121e]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-slate-400 uppercase font-bold">Chart Segments:</span>
          {chartSymbols.map((s) => (
            <span
              key={s}
              className={`btn btn-xs shrink-0 cursor-pointer ${
                symbol === s ? "btn-primary font-bold" : "bg-[#111827] text-slate-300 border-[#263244]"
              }`}
              onClick={() => pickSymbol(s)}
              title={`Open ${s} chart · click ✕ to remove`}
            >
              <span
                role="button"
                tabIndex={0}
                className="mr-1 text-red-400 hover:text-red-300 font-bold"
                onClick={(e) => {
                  e.stopPropagation();
                  setChartSymbols(chartSymbols.filter((x) => x !== s));
                  if (symbol === s && chartSymbols.length > 1) {
                    const next = chartSymbols.find((x) => x !== s);
                    if (next) pickSymbol(next);
                  }
                }}
              >
                ✕
              </span>
              {s}
            </span>
          ))}

          <div className="flex items-center gap-1">
            <input
              className="input mono w-24 text-[11px] py-0.5"
              placeholder="add symbol"
              value={newChartSymbol}
              onChange={(e) => setNewChartSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") addChartSymbol();
              }}
            />
            <button
              className="btn btn-xs bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold"
              onClick={addChartSymbol}
              title="Add symbol to chart segments"
            >
              + Add
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-500 uppercase font-semibold mr-1">Size:</span>
            {(["compact", "normal", "large", "xl"] as const).map((sz) => (
              <button
                key={sz}
                className={`btn btn-xs ${sizePreset === sz && !fullscreen ? "btn-primary font-bold" : ""}`}
                onClick={() => setSize(sz)}
                title={`${sz} height`}
              >
                {sz === "compact" ? "S" : sz === "normal" ? "M" : sz === "large" ? "L" : "XL"}
              </button>
            ))}

            <button
              className={`btn btn-xs ${fullscreen ? "btn-primary font-bold" : ""}`}
              onClick={() => setFullscreen(!fullscreen)}
              title={fullscreen ? "Exit Fullscreen" : "Fullscreen TradingView"}
            >
              {fullscreen ? "✕ Exit Full" : "⛶ Fullscreen"}
            </button>

            <button
              className={`btn btn-xs ${showRightPanel ? "bg-slate-700 text-white" : ""}`}
              onClick={() => setShowRightPanel(!showRightPanel)}
              title="Toggle Algorithmic Signals Panel"
            >
              {showRightPanel ? "Hide Signals ❯" : "❮ Show Signals"}
            </button>
          </div>
        </div>
      </div>

      {/* ACTIVE TRADE ON-CHART BAR (When a position is live for this symbol) */}
      {activeTrade && (
        <div className="bg-[#121c2e] border-b border-sky-500/40 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="badge bg-sky-500/20 text-sky-300 font-bold border border-sky-500/30">
              ACTIVE TRADE ON CHART
            </span>
            <span
              className={`badge font-black ${
                activeTrade.side === "BUY" ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"
              }`}
            >
              {activeTrade.side} {activeTrade.quantity} Qty
            </span>
            <span className="text-slate-300">
              Entry: <b className="text-white">₹{fmt(activeTrade.entryFilledPrice)}</b>
            </span>
            <span className="text-slate-300">
              LTP: <b className="text-white">₹{fmt(ltp)}</b>
            </span>
            <span
              className={`font-black px-2 py-0.5 rounded ${
                activeTradePnl >= 0 ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
              }`}
            >
              P&L: {activeTradePnl >= 0 ? "+" : ""}₹{fmt(activeTradePnl)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-slate-400 text-[10px]">Stop Loss:</span>
              <input
                type="number"
                step="0.05"
                className="input mono w-20 py-0.5 text-xs text-red-300 border-red-500/40"
                value={tradeSlInput}
                onChange={(e) => setTradeSlInput(e.target.value)}
                placeholder="SL"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-400 text-[10px]">Target:</span>
              <input
                type="number"
                step="0.05"
                className="input mono w-20 py-0.5 text-xs text-green-300 border-green-500/40"
                value={tradeTgtInput}
                onChange={(e) => setTradeTgtInput(e.target.value)}
                placeholder="TGT"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-400 text-[10px]">Trail Pts:</span>
              <input
                type="number"
                step="0.5"
                className="input mono w-16 py-0.5 text-xs text-amber-300 border-amber-500/40"
                value={tradeTrailInput}
                onChange={(e) => setTradeTrailInput(e.target.value)}
                placeholder="Trail"
              />
            </div>

            <button
              className="btn btn-xs btn-primary font-bold"
              disabled={updatingTrade}
              onClick={updateTradeLevels}
            >
              💾 Save SL/Tgt
            </button>
            <button
              className="btn btn-xs btn-red font-bold"
              onClick={exitActiveTrade}
              title="Square-off immediately"
            >
              🚪 Exit Trade
            </button>
          </div>
        </div>
      )}

      {/* Main Area: TradingView Chart + Algorithmic Signals & SMC Panel */}
      <div className={`flex flex-col lg:flex-row ${fullscreen ? "flex-1 min-h-0" : ""}`}>
        {/* Chart View */}
        <div className={`flex-1 min-w-0 bg-[#0b0f17] relative ${fullscreen ? "h-full" : ""}`}>
          <TradingViewCanvasChart
            symbol={symbol}
            candles={data?.candles ?? []}
            livePrice={ltp}
            height={fullscreen ? 700 : chartHeight}
            levels={chartLevels}
            currency={curSym}
            showIndicators={true}
            customPineIndicators={customPineIndicators}
          />
        </div>

        {/* Right side: Algorithmic Entry/Exit, Signals & SMC Strategy Card */}
        {showRightPanel && (
          <div
            className={`lg:w-72 shrink-0 border-t lg:border-t-0 lg:border-l border-[#1f2937] p-3 space-y-3 bg-[#0d1320] overflow-y-auto ${
              fullscreen ? "max-h-full" : ""
            }`}
            style={{ maxHeight: fullscreen ? "100%" : chartHeight }}
          >
            {/* Quick Order Buttons directly from Chart */}
            <div className="panel p-2.5 bg-[#0b1220] border-[#263244] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Manual Order from Chart
                </span>
                <Link
                  href={`/options?u=${symbol}`}
                  className="text-[10px] text-purple-400 hover:underline font-bold"
                >
                  Options ↗
                </Link>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn btn-green flex-1 font-bold py-1.5"
                  onClick={() => trade("BUY")}
                >
                  BUY
                </button>
                <button
                  className="btn btn-red flex-1 font-bold py-1.5"
                  onClick={() => trade("SELL")}
                >
                  SELL
                </button>
              </div>
            </div>

            {/* Auto-Trade Status for this Symbol */}
            <div className="panel p-2.5 bg-[#0b1220] border-[#263244] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Auto-Trader for {symbol}
                </span>
                <span
                  className={`badge ${
                    autoTradeConfig.enabled && symbolAutoTraded
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-slate-700 text-slate-400"
                  }`}
                >
                  {autoTradeConfig.enabled && symbolAutoTraded ? "ACTIVE" : "OFF"}
                </span>
              </div>
              <p className="text-[10px] text-slate-400 leading-tight">
                When a confirmed BUY/SELL indicator signal triggers, automatically execute trade with auto SL & Target.
              </p>
              <div className="flex gap-1.5 pt-0.5">
                <button
                  className={`btn btn-xs flex-1 ${
                    symbolAutoTraded ? "bg-amber-500/20 text-amber-300 border-amber-500/40" : "btn-primary"
                  }`}
                  onClick={toggleAutoTradeSymbol}
                >
                  {symbolAutoTraded ? "Remove Symbol" : `+ Auto-Trade ${symbol}`}
                </button>
                <button
                  className="btn btn-xs bg-[#172338] text-slate-300"
                  onClick={() => setShowAutoTradeModal(true)}
                >
                  ⚙️
                </button>
              </div>
            </div>

            {/* SMC (Smart Money Concepts) Plan */}
            {smc && plan && (
              <div
                className={`rounded-lg border p-2.5 ${
                  plan.action === "BUY"
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : plan.action === "SELL"
                    ? "border-red-500/40 bg-red-500/10"
                    : "border-[#263244] bg-[#0b1220]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-wide text-slate-300">
                    SMC Setup Plan
                  </span>
                  <span
                    className={`badge ${
                      plan.bias === "BULLISH"
                        ? "bg-emerald-500/20 text-emerald-300"
                        : plan.bias === "BEARISH"
                        ? "bg-red-500/20 text-red-300"
                        : "bg-slate-600/30 text-slate-300"
                    }`}
                  >
                    {plan.bias} · {smc.equilibrium.pricePosition}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-black ${
                      plan.action === "BUY"
                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                        : plan.action === "SELL"
                        ? "bg-red-500/20 text-red-300 border-red-500/40"
                        : "bg-slate-600/30 text-slate-300 border-slate-500/40"
                    }`}
                  >
                    {plan.action}
                  </span>
                  {plan.inZone && <span className="badge bg-sky-500/20 text-sky-300">IN ZONE ⚡</span>}
                  {plan.riskReward > 0 && (
                    <span className="mono text-[10px] text-slate-400">R:R 1:{plan.riskReward}</span>
                  )}
                </div>
                <div className="mt-1.5 text-[10px] mono space-y-0.5 text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Entry</span>
                    <span className="text-sky-300 font-bold">{fmt(plan.entry)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Stop Loss</span>
                    <span className="down">{fmt(plan.stopLoss)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Target</span>
                    <span className="up">{fmt(plan.target2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">OB/FVG Zone</span>
                    <span className="text-violet-300">{plan.zone}</span>
                  </div>
                </div>
                <div className="mt-1 text-[9px] text-slate-400 leading-snug">{plan.reason}</div>
              </div>
            )}

            {/* Algorithmic Indicator Score */}
            {sig && (
              <div className="panel p-2.5 bg-[#0b1220] border-[#263244] space-y-2">
                <div className="flex items-center justify-between">
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-black ${VOTE_CLS[sig.signal]}`}>
                    {sig.signal}
                  </span>
                  <div className="text-right">
                    <div className="mono text-xs font-bold text-white">
                      {sig.score > 0 ? `+${sig.score}` : sig.score}
                    </div>
                    <div className="text-[9px] text-slate-500 uppercase">{sig.strength}</div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
                  <div className="rounded bg-emerald-500/10 border border-emerald-500/30 py-0.5">
                    <div className="mono font-bold text-emerald-300">{sig.buy}</div>BUY
                  </div>
                  <div className="rounded bg-red-500/10 border border-red-500/30 py-0.5">
                    <div className="mono font-bold text-red-300">{sig.sell}</div>SELL
                  </div>
                  <div className="rounded bg-slate-600/20 border border-slate-600/40 py-0.5">
                    <div className="mono font-bold text-slate-300">{sig.hold}</div>HOLD
                  </div>
                </div>

                <div className="text-[10px] space-y-0.5 mono">
                  <div className="flex justify-between">
                    <span className="text-slate-500">ATR Stop Loss</span>
                    <span className="down">{fmt(sig.levels.stopLoss)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">ATR Target</span>
                    <span className="up">{fmt(sig.levels.target)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Trend / R:R</span>
                    <span className="text-slate-300">
                      {sig.trend} · 1:{sig.levels.riskReward}
                    </span>
                  </div>
                </div>

                {/* Top indicators list with manual configuration trigger */}
                <div className="pt-1 border-t border-[#1f2937]">
                  <div className="flex items-center justify-between pb-1">
                    <span className="text-[9.5px] font-bold text-slate-400">Indicators Readout</span>
                    <button
                      className="text-[9px] text-sky-400 hover:underline"
                      onClick={() => setShowIndModal(true)}
                    >
                      Configure ⚙️
                    </button>
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-0.5">
                    {sig.indicators.map((i) => (
                      <div key={i.id} className="flex items-center justify-between text-[9.5px]">
                        <span className="text-slate-400 truncate max-w-[120px]">{i.name}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          <span className="mono text-slate-300">{i.value}</span>
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[i.vote]}`} />
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Manual Indicator Configuration Modal */}
      {showIndModal && (
        <IndicatorConfigModal
          currentConfig={indConfig}
          customPineIndicators={customPineIndicators}
          previewCandles={data?.candles ?? []}
          onSave={saveManualIndicators}
          onSavePine={savePineIndicators}
          onClose={() => setShowIndModal(false)}
        />
      )}

      {/* Auto-Trade Bot Settings Modal */}
      {showAutoTradeModal && (
        <AutoTradeSettingsModal
          config={autoTradeConfig}
          currentSymbol={symbol}
          onToggleGlobal={toggleAutoTradeGlobal}
          onToggleSymbol={toggleAutoTradeSymbol}
          onSave={async (newCfg) => {
            try {
              const res = await api<{ ok: boolean; autoTrade: typeof autoTradeConfig }>("/api/autotrade", {
                method: "PUT",
                body: JSON.stringify({ autoTrade: newCfg }),
              });
              if (res.autoTrade) setAutoTradeConfig(res.autoTrade);
              toast("Auto-Trade Bot settings updated!", "success");
              setShowAutoTradeModal(false);
            } catch (e) {
              toast((e as Error).message, "error");
            }
          }}
          onClose={() => setShowAutoTradeModal(false)}
        />
      )}

      {draft && <SetupForm initial={draft} onClose={() => setDraft(null)} onSaved={() => setDraft(null)} />}
    </div>
  );
}

// ----------------- Indicator Setup Modal -----------------
function IndicatorConfigModal({
  currentConfig,
  customPineIndicators,
  previewCandles,
  onSave,
  onSavePine,
  onClose,
}: {
  currentConfig: IndicatorConfig;
  customPineIndicators: { id: string; name: string; formula: string; color: string; lineWidth: number; enabled: boolean }[];
  previewCandles: Candle[];
  onSave: (cfg: IndicatorConfig) => void;
  onSavePine: (arr: { id: string; name: string; formula: string; color: string; lineWidth: number; enabled: boolean }[]) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<IndicatorConfig>({ ...currentConfig });
  const [pine, setPine] = useState(customPineIndicators);
  const [pineName, setPineName] = useState("");
  const [pineFormula, setPineFormula] = useState("");
  const [pinePreviewError, setPinePreviewError] = useState("");

  const setF = <K extends keyof IndicatorConfig>(k: K, val: number) => {
    setForm((prev) => ({ ...prev, [k]: val }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="panel w-full max-w-6xl p-5 bg-[#0d1320] border-[#263244] max-h-[95vh] overflow-y-auto space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#1f2937] pb-3">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              ⚙️ Manual Indicator Parameters Setup
            </h2>
            <p className="text-xs text-slate-400">
              Customize parameters for all 10 indicators. Signals, scores & chart overlays will adapt in real-time.
            </p>
          </div>
          <button className="btn btn-xs" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* 1. Supertrend */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-sky-400 block">1. Supertrend</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Period (ATR)</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={1}
                  max={100}
                  value={form.supertrendPeriod}
                  onChange={(e) => setF("supertrendPeriod", Number(e.target.value) || 10)}
                />
              </div>
              <div>
                <label className="label">Multiplier</label>
                <input
                  type="number"
                  step="0.1"
                  className="input mono text-xs py-1"
                  min={0.5}
                  max={10}
                  value={form.supertrendMult}
                  onChange={(e) => setF("supertrendMult", Number(e.target.value) || 3)}
                />
              </div>
            </div>
          </div>

          {/* 2. EMA Crossover */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-amber-400 block">2. EMA 9/21 Cross</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Fast EMA</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={1}
                  max={100}
                  value={form.emaFast}
                  onChange={(e) => setF("emaFast", Number(e.target.value) || 9)}
                />
              </div>
              <div>
                <label className="label">Slow EMA</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={2}
                  max={200}
                  value={form.emaSlow}
                  onChange={(e) => setF("emaSlow", Number(e.target.value) || 21)}
                />
              </div>
            </div>
          </div>

          {/* 3. MACD */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-purple-400 block">3. MACD</span>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="label">Fast</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={1}
                  value={form.macdFast}
                  onChange={(e) => setF("macdFast", Number(e.target.value) || 12)}
                />
              </div>
              <div>
                <label className="label">Slow</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={2}
                  value={form.macdSlow}
                  onChange={(e) => setF("macdSlow", Number(e.target.value) || 26)}
                />
              </div>
              <div>
                <label className="label">Signal</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={1}
                  value={form.macdSignal}
                  onChange={(e) => setF("macdSignal", Number(e.target.value) || 9)}
                />
              </div>
            </div>
          </div>

          {/* 4. RSI */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-violet-300 block">4. RSI</span>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="label">Period</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={2}
                  value={form.rsiPeriod}
                  onChange={(e) => setF("rsiPeriod", Number(e.target.value) || 14)}
                />
              </div>
              <div>
                <label className="label">Overbought</label>
                <input
                  type="number"
                  className="input mono text-xs py-1 text-red-300"
                  min={50}
                  max={95}
                  value={form.rsiOverbought}
                  onChange={(e) => setF("rsiOverbought", Number(e.target.value) || 70)}
                />
              </div>
              <div>
                <label className="label">Oversold</label>
                <input
                  type="number"
                  className="input mono text-xs py-1 text-green-300"
                  min={5}
                  max={50}
                  value={form.rsiOversold}
                  onChange={(e) => setF("rsiOversold", Number(e.target.value) || 30)}
                />
              </div>
            </div>
          </div>

          {/* 5. ADX */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-emerald-400 block">5. ADX</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Period</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={2}
                  value={form.adxPeriod}
                  onChange={(e) => setF("adxPeriod", Number(e.target.value) || 14)}
                />
              </div>
              <div>
                <label className="label">Trend Threshold</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={10}
                  max={50}
                  value={form.adxThreshold}
                  onChange={(e) => setF("adxThreshold", Number(e.target.value) || 20)}
                />
              </div>
            </div>
          </div>

          {/* 6. Bollinger Bands */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-pink-400 block">6. Bollinger Bands</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Period</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={2}
                  value={form.bollingerPeriod}
                  onChange={(e) => setF("bollingerPeriod", Number(e.target.value) || 20)}
                />
              </div>
              <div>
                <label className="label">StdDev Mult</label>
                <input
                  type="number"
                  step="0.1"
                  className="input mono text-xs py-1"
                  min={0.5}
                  max={5}
                  value={form.bollingerMult}
                  onChange={(e) => setF("bollingerMult", Number(e.target.value) || 2)}
                />
              </div>
            </div>
          </div>

          {/* 7. Stochastic */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-amber-300 block">7. Stochastic</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">%K Period</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={2}
                  value={form.stochPeriod}
                  onChange={(e) => setF("stochPeriod", Number(e.target.value) || 14)}
                />
              </div>
              <div>
                <label className="label">%D Smooth</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={1}
                  value={form.stochSmooth}
                  onChange={(e) => setF("stochSmooth", Number(e.target.value) || 3)}
                />
              </div>
            </div>
          </div>

          {/* 8, 9, 10. Moving Averages & Volume */}
          <div className="panel p-3 bg-[#0b1220] border-[#263244] space-y-2">
            <span className="font-bold text-yellow-300 block">8. EMA 50 & Volume</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Price vs EMA</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={10}
                  max={200}
                  value={form.ema50Period}
                  onChange={(e) => setF("ema50Period", Number(e.target.value) || 50)}
                />
              </div>
              <div>
                <label className="label">Vol Avg Period</label>
                <input
                  type="number"
                  className="input mono text-xs py-1"
                  min={5}
                  max={100}
                  value={form.volumePeriod}
                  onChange={(e) => setF("volumePeriod", Number(e.target.value) || 20)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-purple-500/30 bg-[#0b1220] p-3 space-y-3 text-xs">
          <div className="flex items-center justify-between">
            <div className="font-bold text-purple-300 text-sm">🧪 Custom Pine-Style Indicator Builder</div>
            <span className="badge bg-purple-500/20 text-purple-200 border border-purple-500/30">Custom Formula → Chart Overlay</span>
          </div>

          <div className="text-[10px] text-slate-400 leading-relaxed bg-[#09111b] border border-[#263244] rounded p-2.5">
            <div className="font-semibold text-slate-300 mb-1">Supported formula syntax:</div>
            <div className="grid md:grid-cols-2 gap-1 mono">
              <span>• <b>close</b>, open, high, low, volume</span>
              <span>• <b>sma(close,20)</b></span>
              <span>• <b>ema(close,9)</b></span>
              <span>• <b>rsi(close,14)</b></span>
              <span>• <b>highest(high,20)</b></span>
              <span>• <b>lowest(low,20)</b></span>
              <span>• <b>(ema(close,9)+ema(close,21))/2</b></span>
              <span>• <b>close - sma(close,20)</b></span>
            </div>
            <div className="mt-1 text-[9px]">Functions: abs(), min(), max() પણ ચાલે. Real PineScript નહીં, પણ strategy formulas માટે safe builder છે.</div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
            <div className="md:col-span-1">
              <label className="label">Name</label>
              <input className="input text-xs" placeholder="My Edge" value={pineName} onChange={(e) => setPineName(e.target.value)} />
            </div>
            <div className="md:col-span-4">
              <div className="flex items-center justify-between">
                <label className="label">Formula / Pine-Style Script (multi-line supported)</label>
                <span className={`text-[10px] mono ${pineFormula.length > 10000 ? "text-red-400" : "text-slate-500"}`}>
                  {pineFormula.length.toLocaleString("en-IN")} / 10,000 chars
                </span>
              </div>
              <textarea
                className="input mono text-xs min-h-[420px] resize-y leading-relaxed whitespace-pre"
                style={{ maxHeight: "60vh" }}
                placeholder={`Example Pine-style script (each line is a separate plot):\nema(close,9)\n(ema(close,9)+ema(close,21))/2\nhighest(high,20)\nclose - sma(close,20)\nrsi(close,14)`}
                value={pineFormula}
                maxLength={10000}
                onChange={(e) => {
                  const val = e.target.value.slice(0, 10000);
                  setPineFormula(val);
                  if (!val.trim() || !previewCandles.length) {
                    setPinePreviewError("");
                    return;
                  }
                  const lines = val
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean);
                  const results = lines.map((l) => evaluateFormula(previewCandles, l));
                  const bad = results.find((r) => r.error);
                  if (bad) setPinePreviewError(`Line error: ${bad.error}`);
                  else if (!results.length) setPinePreviewError("");
                  else setPinePreviewError(`Preview OK · ${results.length} plot line(s) · Last ${results[results.length - 1].lastValue}`);
                }}
              />
              {pinePreviewError && (
                <div className={`mt-1 text-[10px] ${pinePreviewError.startsWith("Preview OK") ? "text-emerald-300" : "text-amber-300"} mono`}>
                  {pinePreviewError}
                </div>
              )}
              <div className="text-[10px] text-slate-500 mt-1">
                દરેક new line = chart પર અલગ overlay line. Use functions: sma(), ema(), rsi(), highest(), lowest(), abs(), min(), max().
              </div>
            </div>
            <div className="md:col-span-1 flex flex-col gap-2 justify-end">
              <button
                className="btn btn-xs btn-primary font-bold h-9"
                onClick={() => {
                  if (!pineName || !pineFormula) return;
                  const next = [...pine, { id: `pine-${Date.now()}`, name: pineName, formula: pineFormula, color: '#f472b6', lineWidth: 2, enabled: true }];
                  setPine(next); setPineName(''); setPineFormula('');
                  setPinePreviewError("");
                }}
              >
                + Add Pine
              </button>
              <button
                className="btn btn-xs h-9"
                onClick={() => {
                  setPineName("Mean Reversion Mid");
                  setPineFormula("(sma(close,20)+ema(close,9))/2");
                }}
              >
                Example
              </button>
            </div>
          </div>

          <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
            {pine.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 rounded bg-[#09111b] border border-[#263244] px-2 py-1.5">
                <input type="checkbox" checked={p.enabled} onChange={(e) => setPine(pine.map((x) => x.id === p.id ? { ...x, enabled: e.target.checked } : x))} />
                <span className="font-bold min-w-[90px]" style={{ color: p.color }}>{p.name}</span>
                <span className="mono text-[10px] text-slate-400 flex-1 break-all">{p.formula}</span>
                <input type="color" value={p.color} onChange={(e) => setPine(pine.map((x) => x.id === p.id ? { ...x, color: e.target.value } : x))} className="h-5 w-6 bg-transparent p-0 border-0" />
                <input type="number" min={1} max={4} value={p.lineWidth} onChange={(e) => setPine(pine.map((x) => x.id === p.id ? { ...x, lineWidth: Number(e.target.value) || 2 } : x))} className="input mono w-14 py-0.5 text-[10px]" />
                <button className="text-red-400 hover:text-red-300 font-bold" onClick={() => setPine(pine.filter((x) => x.id !== p.id))}>✕</button>
              </div>
            ))}
            {pine.length === 0 && <div className="text-[10px] text-slate-500">No custom indicators yet.</div>}
          </div>
        </div>
        <div className="flex items-center justify-between pt-3 border-t border-[#1f2937]">
          <button
            className="btn btn-xs"
            onClick={() => setForm(DEFAULT_INDICATOR_CONFIG)}
          >
            ↺ Reset Defaults
          </button>
          <div className="flex gap-2">
            <button className="btn btn-xs" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-xs btn-primary font-bold"
              onClick={() => { onSavePine(pine); onSave(form); }}
            >
              💾 Save &amp; Apply Parameters
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------- Auto-Trade Settings Modal -----------------
function AutoTradeSettingsModal({
  config,
  currentSymbol,
  onToggleGlobal,
  onToggleSymbol,
  onSave,
  onClose,
}: {
  config: {
    enabled: boolean;
    symbols: string[];
    interval: string;
    maxPositions: number;
    minScore: number;
    defaultLots: number;
  };
  currentSymbol: string;
  onToggleGlobal: () => void;
  onToggleSymbol: () => void;
  onSave: (newCfg: typeof config) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({ ...config });
  const isCurrentWatched = (config.symbols ?? []).includes(currentSymbol);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="panel w-full max-w-lg p-5 bg-[#0d1320] border-[#263244] space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#1f2937] pb-3">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              🤖 Auto-Trade Bot on Indicator Signals
            </h2>
            <p className="text-xs text-slate-400">
              Executes market orders when indicator score threshold is reached.
            </p>
          </div>
          <button className="btn btn-xs" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Global Master Switch */}
        <div className="panel p-3 bg-[#0b1220] border-[#263244] flex items-center justify-between">
          <div>
            <span className="font-bold text-sm block">Master Auto-Trade Switch</span>
            <span className="text-[11px] text-slate-400">
              {config.enabled ? "Active: Watching signals and auto-entering trades" : "Paused: No auto trades"}
            </span>
          </div>
          <button
            className={`btn btn-xs font-bold ${
              config.enabled ? "btn-green" : "bg-slate-700 text-slate-300"
            }`}
            onClick={onToggleGlobal}
          >
            {config.enabled ? "BOT ON ✓" : "BOT OFF"}
          </button>
        </div>

        {/* Current Symbol Auto-Trade */}
        <div className="panel p-3 bg-[#0b1220] border-[#263244] flex items-center justify-between">
          <div>
            <span className="font-bold text-sm block">Auto-Trade Symbol: {currentSymbol}</span>
            <span className="text-[11px] text-slate-400">
              {isCurrentWatched ? "This symbol is included in the auto-trade bot list" : "Not included"}
            </span>
          </div>
          <button
            className={`btn btn-xs font-bold ${
              isCurrentWatched ? "btn-green" : "btn-primary"
            }`}
            onClick={onToggleSymbol}
          >
            {isCurrentWatched ? "Watched ✓" : "+ Add to Bot"}
          </button>
        </div>

        {/* Parameters */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <label className="label">Min Signal Score (30-80)</label>
            <input
              type="number"
              className="input mono text-xs py-1"
              min={25}
              max={90}
              value={form.minScore}
              onChange={(e) => setForm({ ...form, minScore: Number(e.target.value) || 40 })}
            />
            <span className="text-[10px] text-slate-500">e.g. 40 = BUY &gt;= +40 / SELL &lt;= -40</span>
          </div>

          <div>
            <label className="label">Candle Interval</label>
            <select
              className="input text-xs py-1"
              value={form.interval}
              onChange={(e) => setForm({ ...form, interval: e.target.value })}
            >
              <option value="5m">5 min (Faster signals)</option>
              <option value="15m">15 min (Recommended)</option>
              <option value="30m">30 min</option>
              <option value="60m">1 hour</option>
            </select>
          </div>

          <div>
            <label className="label">Max Open Positions</label>
            <input
              type="number"
              className="input mono text-xs py-1"
              min={1}
              max={10}
              value={form.maxPositions}
              onChange={(e) => setForm({ ...form, maxPositions: Number(e.target.value) || 3 })}
            />
          </div>

          <div>
            <label className="label">Default Lots per Trade</label>
            <input
              type="number"
              className="input mono text-xs py-1"
              min={1}
              max={50}
              value={form.defaultLots}
              onChange={(e) => setForm({ ...form, defaultLots: Number(e.target.value) || 1 })}
            />
          </div>

          <div className="col-span-2">
            <div className="rounded p-2.5 bg-[#0b1220] border border-[#263244] text-[11px] text-slate-300 space-y-1">
              <div className="font-bold text-sky-400">⚡ Auto-Trade Strategy &amp; Rules:</div>
              <div>🎯 <b>Signals &amp; Threshold:</b> Enters trade when composite indicator score &ge; +{form.minScore} (BUY) or &le; -{form.minScore} (SELL)</div>
              <div>📈 <b>RSI Crossover Support:</b> Triggers on RSI crossing 30 (Oversold Buy) or 70 (Overbought Sell)</div>
              <div>🛡️ <b>Auto Risk Management:</b> Auto-sets ATR Stop Loss, Target, and Trailing SL</div>
              <div>🏦 <b>Auto Broker Routing:</b> Routes Indian stocks to Indian Broker (Dhan/Angel/Zerodha), Crypto to Delta Exchange</div>
            </div>
          </div>
        </div>

        {/* List of active auto-traded symbols */}
        <div>
          <label className="label">Auto-Trade Symbol List ({(form.symbols ?? []).length})</label>
          <div className="flex flex-wrap gap-1 mt-1 max-h-24 overflow-y-auto">
            {(form.symbols ?? []).map((s) => (
              <span key={s} className="badge bg-slate-800 text-sky-300 border border-slate-700 flex items-center gap-1">
                {s}
                <button
                  type="button"
                  className="hover:text-red-400 font-bold ml-1"
                  onClick={() =>
                    setForm({
                      ...form,
                      symbols: form.symbols.filter((sym) => sym !== s),
                    })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="text-[10px] text-slate-500 mt-1">
            Add / remove this symbol from the chart button above. The bot watches only these symbols.
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#1f2937]">
          <button className="btn btn-xs" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-xs btn-primary font-bold"
            onClick={() => onSave(form)}
          >
            💾 Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}
