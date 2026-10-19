"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt } from "@/components/utils";
import { toast } from "@/components/Toast";
import { useLiveTicks } from "@/components/useLiveTicks";
import { SetupForm, type SetupDraft } from "@/components/SetupForm";

type Vote = "BUY" | "SELL" | "HOLD";
type Indicator = { id: string; name: string; value: string; vote: Vote; weight: number; detail: string };
type Signal = {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  lotSize: number;
  interval: string;
  signal: Vote;
  strength: string;
  score: number;
  buy: number;
  sell: number;
  hold: number;
  trend: string;
  close: number;
  ltp: number;
  dayChangePct: number;
  priceSource: string;
  candleSource: string;
  indicators: Indicator[];
  levels: { atr: number; stopLoss: number; target: number; support: number; resistance: number; riskReward: number };
  spark: number[];
  candles: number;
  rsiCrossover?: {
    type: string;
    signal: Vote;
    detail: string;
    prevRsi: number;
    currRsi: number;
  };
};
type Res = { interval: string; intervals: { id: string; label: string }[]; summary: { buy: number; sell: number; hold: number }; items: Signal[]; failed: string[]; asOf: number };

const DEFAULT_WATCH = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "BTCUSD", "ETHUSD"];
const STORAGE = "algodesk.signalWatch";
const VOTE_CLS: Record<Vote, string> = { BUY: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", SELL: "bg-red-500/20 text-red-300 border-red-500/40", HOLD: "bg-slate-600/30 text-slate-300 border-slate-500/40" };
const DOT: Record<Vote, string> = { BUY: "bg-emerald-500", SELL: "bg-red-500", HOLD: "bg-slate-500" };

function Spark({ data, up }: { data: number[]; up: boolean }) {
  if (data.length < 2) return <span className="text-slate-600">—</span>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${20 - ((v - min) / range) * 18}`).join(" ");
  return (
    <svg viewBox="0 0 100 20" className="w-20 h-5" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function SignalsPage() {
  const [watch, setWatch] = useState<string[]>(DEFAULT_WATCH);
  const [interval, setIntervalId] = useState("15m");
  const [data, setData] = useState<Res | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState<"ALL" | Vote>("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const [add, setAdd] = useState("");
  const [draft, setDraft] = useState<SetupDraft | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
      if (Array.isArray(saved) && saved.length) setWatch(saved.slice(0, 40));
    } catch {
      /* ignore */
    }
  }, []);
  const saveWatch = (w: string[]) => {
    setWatch(w);
    localStorage.setItem(STORAGE, JSON.stringify(w));
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<Res>(`/api/signals?interval=${interval}&symbols=${watch.join(",")}`));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [interval, watch]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [auto, load]);

  const { ticks } = useLiveTicks(watch);
  const items = useMemo(() => (data?.items ?? []).filter((s) => filter === "ALL" || s.signal === filter), [data, filter]);

  const addSymbol = async () => {
    const sym = add.trim().toUpperCase();
    if (!sym) return;
    if (watch.includes(sym)) return toast(`${sym} already in the list`, "info");
    try {
      const r = await api<{ items: { symbol: string }[] }>(`/api/instruments?q=${encodeURIComponent(sym)}&limit=20`);
      if (!r.items.some((i) => i.symbol === sym)) return toast(`${sym} not found — add it in Stock Finder first`, "error");
      saveWatch([...watch, sym]);
      setAdd("");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const trade = (s: Signal) => {
    const side = s.signal === "SELL" ? "SELL" : "BUY";
    const isIndex = s.segment === "INDEX";
    const isCrypto = s.segment === "CRYPTO";
    const isRsiCross = s.rsiCrossover && s.rsiCrossover.type !== "NONE" && s.rsiCrossover.signal === side;
    setDraft({
      name: `${s.symbol} ${side} · ${isRsiCross ? "RSI Cross" : s.signal} (${s.interval})`,
      symbol: s.symbol,
      underlying: isIndex || isCrypto ? s.symbol : "",
      exchange: isCrypto ? "DELTA" : s.exchange || "NSE",
      segment: isCrypto ? "CRYPTO" : isIndex ? "FUT" : s.segment || "EQ",
      instrumentType: isIndex || isCrypto ? "FUT" : "EQ",
      side,
      quantity: isIndex ? s.lotSize : 1,
      productType: isIndex || isCrypto ? "NRML" : "MIS",
      orderType: "MARKET",
      entryTrigger: isRsiCross ? (side === "BUY" ? "RSI_CROSS_BUY" : "RSI_CROSS_SELL") : "MANUAL",
      entryPrice: ticks[s.symbol]?.ltp ?? s.ltp,
      stopLoss: s.levels.stopLoss,
      target: s.levels.target,
      notes: `${isRsiCross ? `Triggered by ${s.rsiCrossover?.detail}` : `Auto-filled from ${s.signal} signal`} · RSI Exit on opposite cross · SL/Target from ATR ${s.levels.atr}`,
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Indicator Signals</h1>
          <p className="text-xs text-slate-400">Supertrend · EMA 9/21 · MACD · RSI · ADX · Bollinger · Stochastic · VWAP · Volume → one BUY / SELL / HOLD call per symbol</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">Timeframe</label>
            <select className="input w-28" value={interval} onChange={(e) => setIntervalId(e.target.value)}>
              {(data?.intervals ?? [{ id: "15m", label: "15 min" }]).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Add symbol</label>
            <div className="flex gap-1">
              <input className="input mono w-32" value={add} onChange={(e) => setAdd(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && addSymbol()} placeholder="TATASTEEL" />
              <button className="btn btn-xs" onClick={addSymbol}>
                +
              </button>
            </div>
          </div>
          <button className="btn" disabled={loading} onClick={load}>
            {loading ? "Scanning…" : "↻ Scan"}
          </button>
          <label className="flex items-center gap-2 text-xs pb-2">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto 30s
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <button className={`panel p-3 text-left ${filter === "ALL" ? "border-sky-500/50" : ""}`} onClick={() => setFilter("ALL")}>
          <div className="text-[10px] text-slate-400 uppercase font-semibold">Scanned</div>
          <div className="mono text-lg font-bold">{data?.items.length ?? 0}</div>
        </button>
        <button className={`panel p-3 text-left ${filter === "BUY" ? "border-emerald-500/50" : ""}`} onClick={() => setFilter("BUY")}>
          <div className="text-[10px] text-slate-400 uppercase font-semibold">Buy</div>
          <div className="mono text-lg font-bold up">{data?.summary.buy ?? 0}</div>
        </button>
        <button className={`panel p-3 text-left ${filter === "SELL" ? "border-red-500/50" : ""}`} onClick={() => setFilter("SELL")}>
          <div className="text-[10px] text-slate-400 uppercase font-semibold">Sell</div>
          <div className="mono text-lg font-bold down">{data?.summary.sell ?? 0}</div>
        </button>
        <button className={`panel p-3 text-left ${filter === "HOLD" ? "border-slate-400/50" : ""}`} onClick={() => setFilter("HOLD")}>
          <div className="text-[10px] text-slate-400 uppercase font-semibold">Hold</div>
          <div className="mono text-lg font-bold text-slate-300">{data?.summary.hold ?? 0}</div>
        </button>
        <div className="panel p-3">
          <div className="text-[10px] text-slate-400 uppercase font-semibold">Updated</div>
          <div className="mono text-sm font-bold">{data ? new Date(data.asOf).toLocaleTimeString("en-IN", { hour12: false }) : "—"}</div>
          <div className="text-[10px] text-slate-500">candles {data?.items[0]?.candleSource ?? "—"}</div>
        </div>
      </div>

      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Signal</th>
              <th>Score</th>
              <th>LTP</th>
              <th>Day %</th>
              <th>Trend</th>
              <th>Votes</th>
              <th>Chart</th>
              <th>Stop Loss</th>
              <th>Target</th>
              <th>R:R</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const t = ticks[s.symbol];
              const ltp = t?.ltp ?? s.ltp;
              const chg = t?.changePct ?? s.dayChangePct;
              const expanded = open === s.symbol;
              return (
                <Fragment key={s.symbol}>
                  <tr className="cursor-pointer" onClick={() => setOpen(expanded ? null : s.symbol)}>
                    <td>
                      <div className="mono font-bold">{s.symbol}</div>
                      <div className="text-[10px] text-slate-500 max-w-[150px] truncate">{s.name}</div>
                    </td>
                    <td>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-black ${VOTE_CLS[s.signal]}`}>
                        {s.signal}
                      </span>
                      <div className="text-[9px] text-slate-500 mt-0.5">{s.strength}</div>
                      {s.rsiCrossover && s.rsiCrossover.type !== "NONE" && (
                        <div className="mt-0.5">
                          <span
                            className={`badge text-[8.5px] font-bold ${
                              s.rsiCrossover.signal === "BUY"
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : "bg-red-500/20 text-red-300 border border-red-500/30"
                            }`}
                            title={s.rsiCrossover.detail}
                          >
                            RSI {s.rsiCrossover.signal}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="min-w-[90px]">
                      <div className="mono text-xs font-bold">{s.score > 0 ? `+${s.score}` : s.score}</div>
                      <div className="h-1.5 w-16 rounded-full bg-slate-800 overflow-hidden mt-0.5 relative">
                        <div
                          className={`absolute top-0 h-full ${s.score >= 0 ? "bg-emerald-500 left-1/2" : "bg-red-500 right-1/2"}`}
                          style={{ width: `${Math.min(Math.abs(s.score) / 2, 50)}%` }}
                        />
                      </div>
                    </td>
                    <td className="mono font-semibold">
                      <span key={t?.flashAt} className={t?.flashAt ? (t.dir === "up" ? "flash-up" : "flash-down") : ""}>
                        {fmt(ltp)}
                      </span>
                    </td>
                    <td className={`mono ${chg >= 0 ? "up" : "down"}`}>
                      {chg >= 0 ? "+" : ""}
                      {fmt(chg)}%
                    </td>
                    <td className="text-xs">{s.trend === "UP" ? <span className="up">▲ Up</span> : s.trend === "DOWN" ? <span className="down">▼ Down</span> : <span className="text-slate-400">↔ Range</span>}</td>
                    <td className="text-[11px] mono">
                      <span className="up">{s.buy}</span> / <span className="down">{s.sell}</span> / <span className="text-slate-400">{s.hold}</span>
                    </td>
                    <td>
                      <Spark data={s.spark} up={s.score >= 0} />
                    </td>
                    <td className="mono text-xs down">{fmt(s.levels.stopLoss)}</td>
                    <td className="mono text-xs up">{fmt(s.levels.target)}</td>
                    <td className="mono text-xs">1:{s.levels.riskReward}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button className={`btn btn-xs ${s.signal === "SELL" ? "btn-red" : "btn-green"}`} disabled={s.signal === "HOLD"} onClick={() => trade(s)} title={s.signal === "HOLD" ? "No clear signal" : `Create ${s.signal} setup`}>
                          {s.signal === "SELL" ? "Sell" : "Buy"}
                        </button>
                        <button className="btn btn-xs" onClick={() => setOpen(expanded ? null : s.symbol)}>
                          {expanded ? "▲" : "▼"}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={12} className="bg-[#0b1220]">
                        <div className="p-3 space-y-3">
                          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
                            <Box k="Support (20)" v={fmt(s.levels.support)} />
                            <Box k="Resistance (20)" v={fmt(s.levels.resistance)} />
                            <Box k="ATR" v={fmt(s.levels.atr)} />
                            <Box k="Candles" v={`${s.candles} × ${s.interval}`} />
                            <Box k="Price feed" v={s.priceSource} />
                            <Box k="Candle data" v={s.candleSource} />
                          </div>
                          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
                            {s.indicators.map((i) => (
                              <div key={i.id} className="rounded-lg border border-[#263244] bg-[#111827] p-2.5">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-semibold">{i.name}</span>
                                  <span className={`badge ${i.vote === "BUY" ? "bg-emerald-500/20 text-emerald-300" : i.vote === "SELL" ? "bg-red-500/20 text-red-300" : "bg-slate-600/30 text-slate-400"}`}>
                                    <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${DOT[i.vote]}`} />
                                    {i.vote}
                                  </span>
                                </div>
                                <div className="mono text-sm font-bold mt-0.5">{i.value}</div>
                                <div className="text-[10px] text-slate-400 mt-0.5">{i.detail}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!items.length && (
              <tr>
                <td colSpan={12} className="text-center text-slate-500 py-8">
                  {loading ? "Scanning indicators…" : "No symbols match this filter"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-slate-500 mr-1">Watchlist:</span>
        {watch.map((w) => (
          <span key={w} className="badge bg-slate-700/50 text-slate-300">
            {w}
            <button className="ml-1 text-slate-500 hover:text-red-300" onClick={() => saveWatch(watch.filter((x) => x !== w))}>
              ✕
            </button>
          </span>
        ))}
        <button className="btn btn-xs" onClick={() => saveWatch(DEFAULT_WATCH)}>
          Reset
        </button>
      </div>

      <p className="text-[11px] text-slate-500 leading-relaxed">
        Signals are computed from historical candles (Yahoo Finance; simulated when unavailable) with the live LTP applied to the latest candle. This is a mechanical indicator summary, <b>not investment advice</b> — always
        confirm before trading and keep the stop loss. HOLD means the indicators disagree (no edge).
      </p>

      {draft && <SetupForm initial={draft} onClose={() => setDraft(null)} onSaved={() => setDraft(null)} />}
    </div>
  );
}

function Box({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded border border-[#1f2937] bg-[#0d1320] px-2 py-1.5">
      <div className="text-[9px] uppercase text-slate-500">{k}</div>
      <div className="mono text-slate-100 truncate">{v}</div>
    </div>
  );
}
