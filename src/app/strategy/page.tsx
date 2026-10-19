"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Strategy } from "@/db/schema";
import type { PayoffResult } from "@/lib/strategies";
import type { Quote } from "@/lib/market";
import type { BacktestSummary } from "@/lib/backtest";
import { api, fmt } from "@/components/utils";
import { toast } from "@/components/Toast";

type Preview = {
  underlying: string;
  name: string;
  spot: Quote;
  marginPerLot: number;
  perLotPremium: number;
  atm: number;
  step: number;
  expiry: string;
  expiries: string[];
  lotSize: number;
  strikes: number[];
  payoff: PayoffResult;
  capital: { free: number; used: number; total: number; affordable: boolean; maxLots: number };
  template: { id: string; name: string; desc: string; outlook: string };
};

import type { IndicatorTriggerRule } from "@/lib/strategies";

type Tpl = {
  id: string;
  name: string;
  desc: string;
  outlook: string;
  category?: "CLASSIC" | "INDICATOR_BASED" | "CUSTOM";
  indicatorTrigger?: IndicatorTriggerRule;
  legs: { instrumentType: string; offset: number; side: string; ratio: number }[];
};
type Leg = { instrumentType: "CE" | "PE" | "FUT"; offset: number; side: "BUY" | "SELL"; ratio: number };

export default function StrategyBuilderPage() {
  const [underlying, setUnderlying] = useState("NIFTY");
  const [underlyings, setUnderlyings] = useState<{ symbol: string; name: string; lotSize: number }[]>([]);
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [templateId, setTemplateId] = useState("LONG_STRADDLE");
  const [expiry, setExpiry] = useState("");
  const [lots, setLots] = useState(1);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [pv, setPv] = useState<Preview | null>(null);
  const [saved, setSaved] = useState<(Strategy & { legs: { id: number; name: string; status: string; side: string; quantity: number; pnl: number }[]; combinedPnl: number; openLegs: number })[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  // Indicator Trigger Rules configuration
  const [customIndicator, setCustomIndicator] = useState<IndicatorTriggerRule["indicator"]>("SUPERTREND");
  const [customCondition, setCustomCondition] = useState<IndicatorTriggerRule["condition"]>("BUY");
  const [customMinScore, setCustomMinScore] = useState<number>(35);
  const [customConfirmCandles, setCustomConfirmCandles] = useState<0 | 1 | 2>(0);
  const [customExitOnFlip, setCustomExitOnFlip] = useState<boolean>(true);
  const [enableIndicatorTrigger, setEnableIndicatorTrigger] = useState<boolean>(false);

  // Backtest state
  const [btInterval, setBtInterval] = useState("15m");
  const [btTargetPct, setBtTargetPct] = useState(40);
  const [btStopLossPct, setBtStopLossPct] = useState(30);
  const [btHoldingBars, setBtHoldingBars] = useState(16);
  const [btRunning, setBtRunning] = useState(false);
  const [btDownloading, setBtDownloading] = useState(false);
  const [btResult, setBtResult] = useState<BacktestSummary | null>(null);

  useEffect(() => {
    api<{ items: { symbol: string; name: string; lotSize: number; segment: string; isFno: boolean }[] }>("/api/instruments?fno=1&segment=INDEX&limit=50").then((r) => {
      const idx = r.items;
      api<{ items: { symbol: string; name: string; lotSize: number; isFno: boolean }[] }>("/api/instruments?fno=1&segment=EQ&limit=500").then((r2) => {
        setUnderlyings([...idx, ...r2.items]);
      });
    });
    api<{ items: Omit<typeof saved, never>[] }>("/api/strategies").then((r) => setSaved(r.items as never));
    api<{ templates: Tpl[] }>("/api/strategies").then((r) => setTemplates(r.templates));
  }, []);

  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id);
      const t = templates.find((x) => x.id === id);
      if (t) {
        setLegs(t.legs.map((l) => ({ instrumentType: l.instrumentType as Leg["instrumentType"], offset: l.offset, side: l.side as Leg["side"], ratio: l.ratio })));
        if (t.indicatorTrigger) {
          setEnableIndicatorTrigger(true);
          setCustomIndicator(t.indicatorTrigger.indicator);
          setCustomCondition(t.indicatorTrigger.condition);
          setCustomMinScore(t.indicatorTrigger.minScore ?? 35);
          setCustomConfirmCandles(t.indicatorTrigger.confirmCandles ?? 0);
          setCustomExitOnFlip(t.indicatorTrigger.exitOnSignalFlip ?? true);
          if (t.indicatorTrigger.indicator === "EMA_CROSS" || t.indicatorTrigger.indicator === "ORB_BREAKOUT") {
            setBtInterval("5m");
          }
        } else {
          setEnableIndicatorTrigger(false);
        }
      }
    },
    [templates],
  );

  useEffect(() => {
    if (templates.length && legs.length === 0) applyTemplate("LONG_STRADDLE");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  const preview = useCallback(async () => {
    const p = new URLSearchParams({ underlying, template: templateId, lots: String(lots), action: "preview" });
    if (expiry) p.set("expiry", expiry);
    try {
      const r = await api<Preview>(`/api/strategies?${p}`, {
        method: "POST",
        body: JSON.stringify({ action: "preview", underlying, template: templateId, lots, expiry, legs }),
      });
      setPv(r);
      if (!expiry) setExpiry(r.expiry);
    } catch {
      /* ignore */
    }
  }, [underlying, templateId, lots, expiry, legs]);

  useEffect(() => {
    preview();
    const id = setInterval(preview, 5000);
    return () => clearInterval(id);
  }, [preview]);

  const loadSaved = useCallback(() => {
    api<{ items: typeof saved }>("/api/strategies").then((r) => setSaved(r.items));
  }, []);

  const create = async (arm: boolean) => {
    setBusy(true);
    try {
      const indicatorTrigger: IndicatorTriggerRule | undefined = enableIndicatorTrigger
        ? {
            indicator: customIndicator,
            condition: customCondition,
            minScore: customMinScore,
            confirmCandles: customConfirmCandles,
            exitOnSignalFlip: customExitOnFlip,
          }
        : undefined;

      const r = await api<{ strategy: Strategy; setups: { id: number }[] }>("/api/strategies", {
        method: "POST",
        body: JSON.stringify({
          name: name || undefined,
          underlying,
          template: templateId,
          lots,
          expiry,
          legs,
          indicatorTrigger,
        }),
      });
      toast(`${r.setups.length} leg setup created${arm ? " & armed" : ""}`, "success");
      setName("");
      if (arm) await api(`/api/strategies/${r.strategy.id}`, { method: "POST", body: JSON.stringify({ action: "arm" }) });
      loadSaved();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: number, action: string) => {
    try {
      const r = await api<{ ok: boolean; message: string }>(`/api/strategies/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      toast(r.message, r.ok ? "success" : "error");
      loadSaved();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const del = async (id: number) => {
    if (!confirm("Delete strategy and all its legs?")) return;
    try {
      await api(`/api/strategies?ids=${id}`, { method: "DELETE" });
      toast("Strategy deleted", "info");
      loadSaved();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const runBacktest = async () => {
    setBtRunning(true);
    try {
      const indicatorTrigger: IndicatorTriggerRule | undefined = enableIndicatorTrigger
        ? {
            indicator: customIndicator,
            condition: customCondition,
            minScore: customMinScore,
            confirmCandles: customConfirmCandles,
            exitOnSignalFlip: customExitOnFlip,
          }
        : undefined;

      const res = await api<{ ok: boolean; summary: BacktestSummary }>("/api/strategy-backtest", {
        method: "POST",
        body: JSON.stringify({
          underlying,
          template: templateId,
          interval: btInterval,
          lots,
          legs,
          strategyName: name || undefined,
          targetPct: btTargetPct,
          stopLossPct: btStopLossPct,
          holdingBars: btHoldingBars,
          indicatorTrigger,
        }),
      });
      if (res.ok && res.summary) {
        setBtResult(res.summary);
        toast(`Backtest Complete! ${res.summary.totalTrades} trades simulated (Win Rate: ${res.summary.winRate}%)`, "success");
      }
    } catch (e) {
      toast((e as Error).message || "Backtest failed", "error");
    } finally {
      setBtRunning(false);
    }
  };

  const downloadBacktestExcel = async () => {
    setBtDownloading(true);
    try {
      const indicatorTrigger: IndicatorTriggerRule | undefined = enableIndicatorTrigger
        ? {
            indicator: customIndicator,
            condition: customCondition,
            minScore: customMinScore,
            exitOnSignalFlip: customExitOnFlip,
          }
        : undefined;

      const resp = await fetch("/api/strategy-backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          underlying,
          template: templateId,
          interval: btInterval,
          lots,
          legs,
          strategyName: name || undefined,
          targetPct: btTargetPct,
          stopLossPct: btStopLossPct,
          holdingBars: btHoldingBars,
          indicatorTrigger,
          exportExcel: true,
        }),
      });

      if (!resp.ok) throw new Error("Failed to download backtest report");

      const blob = await resp.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Backtest-${underlying}-${templateId}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast("Backtest Excel Report Downloaded ✓", "success");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBtDownloading(false);
    }
  };

  // Equity Curve for Backtesting
  const equitySvg = useMemo(() => {
    if (!btResult || !btResult.equityCurve.length) return null;
    const curve = btResult.equityCurve;
    const minEq = Math.min(...curve.map((c) => c.equity));
    const maxEq = Math.max(...curve.map((c) => c.equity));
    const range = maxEq - minEq || 1;
    const w = 100;
    const h = 40;
    const px = (i: number) => (i / (curve.length - 1 || 1)) * w;
    const py = (v: number) => h - ((v - minEq) / range) * h;
    const line = curve.map((c, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(2)},${py(c.equity).toFixed(2)}`).join(" ");
    return { line, minEq, maxEq, w, h };
  }, [btResult]);

  const chart = useMemo(() => {
    if (!pv) return null;
    const p = pv.payoff.payoff;
    const max = Math.max(...p.map((x) => Math.abs(x.pnl)), 1);
    const w = 100;
    const h = 40;
    const px = (i: number) => (i / (p.length - 1)) * w;
    const py = (v: number) => h / 2 - (v / max) * (h / 2);
    const line = p.map((d, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(2)},${py(d.pnl).toFixed(2)}`).join(" ");
    const zero = `M0,${h / 2} L${w},${h / 2}`;
    return { line, zero, w, h, min: p[0].price, max: p[p.length - 1].price, maxAbs: max };
  }, [pv]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Strategy Builder</h1>
        <p className="text-xs text-slate-400">Multi-leg option strategies → auto-created as grouped algo setups with per-leg entry / exit, SL &amp; target</p>
      </div>

      {/* Builder inputs */}
      <div className="panel p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <div>
            <label className="label">Underlying</label>
            <select
              className="input"
              value={underlying}
              onChange={(e) => {
                setUnderlying(e.target.value);
                setExpiry("");
              }}
            >
              {underlyings.map((u) => (
                <option key={u.symbol} value={u.symbol}>
                  {u.symbol} ({u.lotSize})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Expiry</label>
            <select className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {pv?.expiries.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Lots (1 = {pv?.lotSize ?? 1} qty)</label>
            <div className="flex gap-1">
              <button className="btn btn-xs" onClick={() => setLots(Math.max(1, lots - 1))}>
                −
              </button>
              <input className="input mono text-center" type="number" min={1} value={lots} onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))} />
              <button className="btn btn-xs" onClick={() => setLots(lots + 1)}>
                +
              </button>
            </div>
          </div>
          <div className="col-span-2">
            <label className="label">Strategy Name (optional)</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly Iron Condor" />
          </div>
          <div className="flex items-end">
            <div className="text-xs w-full">
              <div className="text-slate-400">
                Spot <span className="mono font-bold text-slate-100">{pv ? fmt(pv.spot.ltp) : "—"}</span>
              </div>
              <div className="text-slate-400">
                ATM <span className="mono text-sky-300">{pv?.atm ?? "—"}</span> · step {pv?.step ?? "—"}
              </div>
            </div>
          </div>
        </div>

        {/* Templates */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label mb-0">Strategy Template</label>
            <span className="text-[10px] text-slate-400">Classic Spreads or Indicator-Triggered Setups</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {templates.map((t) => (
              <button
                key={t.id}
                className={`btn btn-xs ${templateId === t.id ? "btn-primary font-bold shadow-sm" : ""}`}
                onClick={() => applyTemplate(t.id)}
                title={`${t.desc} · Outlook: ${t.outlook}`}
              >
                {t.name}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
            <span>
              {pv?.template.desc} — outlook: <b className="text-slate-200">{pv?.template.outlook}</b>
              {templates.find((t) => t.id === templateId)?.category === "INDICATOR_BASED" && (
                <span className="ml-2 badge bg-sky-500/20 text-sky-300 border border-sky-500/30">Indicator-Based</span>
              )}
            </span>
          </div>
        </div>

        {/* Indicator-Based Automation Trigger Configuration */}
        <div className="rounded-lg border border-sky-500/30 bg-[#0c1424] p-3 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="enable-ind-trig"
                checked={enableIndicatorTrigger}
                onChange={(e) => setEnableIndicatorTrigger(e.target.checked)}
                className="accent-sky-400 cursor-pointer rounded"
              />
              <label htmlFor="enable-ind-trig" className="font-bold text-sky-300 cursor-pointer flex items-center gap-1.5">
                <span>🎯 Indicator-Based Auto Entry &amp; Exit Trigger</span>
                <span className="badge bg-sky-500/20 text-sky-200 text-[10px]">Strategy Automation</span>
              </label>
            </div>
            <span className="text-[10px] text-slate-400">
              {enableIndicatorTrigger ? "Active: Enters when indicator conditions trigger" : "Off: Manual execution"}
            </span>
          </div>

          {enableIndicatorTrigger && (
            <div className="pt-2 border-t border-[#1f2937] space-y-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div>
                  <label className="label">Trigger Indicator</label>
                  <select
                    className="input text-xs py-1"
                    value={customIndicator}
                    onChange={(e) => setCustomIndicator(e.target.value as IndicatorTriggerRule["indicator"])}
                  >
                    <option value="EMA_CROSS">EMA 9/21 Cross (5m)</option>
                    <option value="ORB_BREAKOUT">ORB Opening Range Breakout</option>
                    <option value="SUPERTREND">Supertrend (Flip)</option>
                    <option value="RSI_CROSSOVER">RSI Crossover (30/70/50)</option>
                    <option value="MACD">MACD Histogram</option>
                    <option value="ALL_COMBINED">All Indicators Score</option>
                  </select>
                </div>

                <div>
                  <label className="label">Entry Direction</label>
                  <select
                    className="input text-xs py-1"
                    value={customCondition}
                    onChange={(e) => setCustomCondition(e.target.value as IndicatorTriggerRule["condition"])}
                  >
                    <option value="BUY">CALL / Bullish Signal (BUY)</option>
                    <option value="SELL">PUT / Bearish Signal (SELL)</option>
                  </select>
                </div>

                {customIndicator === "EMA_CROSS" && (
                  <div>
                    <label className="label">Candle Entry Mode (5m)</label>
                    <select
                      className="input text-xs py-1"
                      value={customConfirmCandles}
                      onChange={(e) => setCustomConfirmCandles(Number(e.target.value) as 0 | 1 | 2)}
                    >
                      <option value={0}>Running Candle (Instant)</option>
                      <option value={1}>-1 Candle Confirmation</option>
                      <option value={2}>-2 Candle Confirmation</option>
                    </select>
                  </div>
                )}

                {customIndicator === "ALL_COMBINED" && (
                  <div>
                    <label className="label">Min Score Threshold</label>
                    <input
                      type="number"
                      min={20}
                      max={85}
                      className="input mono text-xs py-1"
                      value={customMinScore}
                      onChange={(e) => setCustomMinScore(Number(e.target.value) || 35)}
                    />
                  </div>
                )}

                <div className="flex items-center gap-1.5 pt-3">
                  <input
                    type="checkbox"
                    id="exit-flip"
                    checked={customExitOnFlip}
                    onChange={(e) => setCustomExitOnFlip(e.target.checked)}
                    className="accent-sky-400 cursor-pointer rounded"
                  />
                  <label htmlFor="exit-flip" className="text-[11px] text-slate-300 cursor-pointer">
                    Auto-exit on opposite signal
                  </label>
                </div>
              </div>

              <div className="text-[10px] text-slate-400 bg-[#080d17] p-2 rounded border border-[#1a2538] leading-relaxed">
                ℹ️ <b>Indicator Strategy Rule:</b> When <b>{customIndicator}</b> triggers a <b>{customCondition}</b> signal on <b>{underlying}</b>, the strategy builds setups with auto broker routing (🇮🇳 Indian broker / ₿ Delta Exchange), SL/Target/trailing SL, and can auto-enter / auto-exit on signal flip.
              </div>
            </div>
          )}
        </div>

        {/* Legs editor */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="label mb-0">Legs (offset = strikes from ATM)</label>
            <button className="btn btn-xs" onClick={() => setLegs([...legs, { instrumentType: "CE", offset: legs.length, side: "BUY", ratio: 1 }])}>
              + Leg
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Type</th>
                  <th>Offset (steps)</th>
                  <th>Strike</th>
                  <th>Side</th>
                  <th>Ratio × lot</th>
                  <th>Premium</th>
                  <th>Qty</th>
                  <th>SL / Target</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(pv?.payoff.legs ?? []).map((l, i) => (
                  <tr key={i}>
                    <td className="mono text-slate-500">L{i + 1}</td>
                    <td>
                      <select
                        className="input w-20"
                        value={legs[i]?.instrumentType ?? "CE"}
                        onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, instrumentType: e.target.value as Leg["instrumentType"] } : x)))}
                      >
                        <option>CE</option>
                        <option>PE</option>
                        <option>FUT</option>
                      </select>
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <button className="btn btn-xs" onClick={() => setLegs(legs.map((x, j) => (j === i ? { ...x, offset: x.offset - 1 } : x)))}>
                          −
                        </button>
                        <span className="mono w-8 text-center self-center">{legs[i]?.offset ?? 0}</span>
                        <button className="btn btn-xs" onClick={() => setLegs(legs.map((x, j) => (j === i ? { ...x, offset: x.offset + 1 } : x)))}>
                          +
                        </button>
                      </div>
                    </td>
                    <td className="mono font-semibold">{l.instrumentType === "FUT" ? "FUT" : l.strike}</td>
                    <td>
                      <button
                        className={`btn btn-xs ${legs[i]?.side === "BUY" ? "btn-green" : "btn-red"}`}
                        onClick={() => setLegs(legs.map((x, j) => (j === i ? { ...x, side: x.side === "BUY" ? "SELL" : "BUY" } : x)))}
                      >
                        {legs[i]?.side ?? l.side}
                      </button>
                    </td>
                    <td>
                      <input
                        className="input mono w-16"
                        type="number"
                        min={1}
                        max={4}
                        value={legs[i]?.ratio ?? 1}
                        onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, ratio: Math.max(1, Number(e.target.value) || 1) } : x)))}
                      />
                    </td>
                    <td className="mono">{fmt(l.premium)}</td>
                    <td className="mono">{l.quantity}</td>
                    <td className="mono text-[11px]">
                      <span className="down">SL {legs[i]?.side === "BUY" ? "50%" : "+150%"}</span> / <span className="up">Tgt {legs[i]?.side === "BUY" ? "100%" : "100%"}</span>
                    </td>
                    <td>
                      <button className="btn btn-xs" onClick={() => setLegs(legs.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Payoff + capital */}
        {pv && chart && (
          <div className="grid lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-lg border border-[#263244] bg-[#0b1220] p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-300">Payoff at Expiry (±12%)</span>
                <span className="text-[10px] text-slate-500">
                  {chart.min.toFixed(0)} → {chart.max.toFixed(0)}
                </span>
              </div>
              <svg viewBox={`0 0 ${chart.w} ${chart.h}`} className="w-full h-40" preserveAspectRatio="none">
                <path d={chart.zero} stroke="#334155" strokeWidth="0.3" fill="none" />
                <path d={chart.line} stroke="#38bdf8" strokeWidth="0.6" fill="none" />
              </svg>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2 text-center">
                <Cell label="Net Premium" value={`₹${fmt(pv.payoff.netCashflow, 0)}`} cls={pv.payoff.netCashflow >= 0 ? "up" : "down"} note={pv.payoff.netCashflow >= 0 ? "credit" : "debit"} />
                <Cell label="Max Profit" value={`₹${fmt(pv.payoff.maxProfit, 0)}`} cls="up" />
                <Cell label="Max Loss" value={`₹${fmt(pv.payoff.maxLoss, 0)}`} cls="down" />
                <Cell label="Breakeven" value={pv.payoff.breakevens.map((b) => b.toFixed(0)).join(" / ") || "—"} />
              </div>
            </div>
            <div className="space-y-2">
              <div className="rounded-lg border border-[#263244] bg-[#0b1220] p-3">
                <div className="text-xs font-bold text-slate-300 mb-2">Capital Check</div>
                <Row label="Margin required" value={`₹${fmt(pv.payoff.marginRequired, 0)}`} />
                <Row label="Per 1 lot" value={`₹${fmt(pv.marginPerLot, 0)}`} />
                <Row label="Free capital" value={`₹${fmt(pv.capital.free, 0)}`} />
                <Row label="Total capital" value={`₹${fmt(pv.capital.total, 0)}`} />
                <div className={`mt-2 rounded px-2 py-1.5 text-xs font-semibold ${pv.capital.affordable ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                  {pv.capital.affordable ? "✓ Affordable with current capital" : "✕ Reduce lots — margin exceeds free capital"}
                </div>
                {pv.capital.affordable && pv.capital.maxLots < lots && (
                  <button className="btn btn-xs w-full mt-2" onClick={() => setLots(Math.max(1, pv.capital.maxLots))}>
                    Fit to capital ({Math.max(1, pv.capital.maxLots)} lot)
                  </button>
                )}
                {!pv.capital.affordable && (
                  <div className="text-[10px] text-slate-500">
                    {pv.capital.maxLots < 1
                      ? `₹${fmt(pv.capital.free, 0)} free is not enough for 1 lot (needs ₹${fmt(pv.marginPerLot, 0)}). Try cheaper strikes, an OTM-only strategy, a stock option, or raise capital in Capital &amp; Risk.`
                      : ""}
                  </div>
                )}
                {!pv.capital.affordable && pv.capital.maxLots >= 1 && (
                  <button className="btn btn-xs w-full mt-2" onClick={() => setLots(Math.max(1, pv.capital.maxLots))}>
                    Reduce to {Math.max(1, pv.capital.maxLots)} lot
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button className="btn flex-1" disabled={busy} onClick={() => create(false)}>
                  Save Strategy
                </button>
                <button className="btn btn-primary flex-1" disabled={busy || !pv.capital.affordable} onClick={() => create(true)}>
                  Save &amp; Arm ▶
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- Strategy Backtesting & Report Section ---------------- */}
        <div className="rounded-lg border border-[#263244] bg-[#0b1220] p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f2937] pb-3">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span>📊 Strategy Backtesting Engine</span>
                <span className="badge bg-sky-500/20 text-sky-300 border border-sky-500/30">Historical Simulation</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Run this multi-leg option strategy on historical candles to analyze Win Rate, Drawdown &amp; Net P&amp;L
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn btn-primary font-bold px-4"
                disabled={btRunning}
                onClick={runBacktest}
              >
                {btRunning ? "⏳ Simulating…" : "▶ Run Backtest"}
              </button>

              {btResult && (
                <button
                  className="btn btn-green font-bold flex items-center gap-1.5"
                  disabled={btDownloading}
                  onClick={downloadBacktestExcel}
                >
                  {btDownloading ? "Building…" : "⤓ Download Report (.xlsx)"}
                </button>
              )}
            </div>
          </div>

          {/* Backtest Parameters */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <label className="label">Candle Timeframe</label>
              <select
                className="input py-1 text-xs"
                value={btInterval}
                onChange={(e) => setBtInterval(e.target.value)}
              >
                <option value="5m">5 min (Fast / Scalp)</option>
                <option value="15m">15 min (Recommended)</option>
                <option value="30m">30 min (Intraday)</option>
                <option value="60m">1 Hour (Swing)</option>
                <option value="1d">1 Day (Positional)</option>
              </select>
            </div>

            <div>
              <label className="label">Profit Target (%)</label>
              <input
                type="number"
                min={5}
                max={200}
                className="input mono py-1 text-xs text-green-300"
                value={btTargetPct}
                onChange={(e) => setBtTargetPct(Number(e.target.value) || 40)}
              />
              <span className="text-[10px] text-slate-500 mt-0.5 block">Square off on max profit</span>
            </div>

            <div>
              <label className="label">Stop Loss Limit (%)</label>
              <input
                type="number"
                min={5}
                max={100}
                className="input mono py-1 text-xs text-red-300"
                value={btStopLossPct}
                onChange={(e) => setBtStopLossPct(Number(e.target.value) || 30)}
              />
              <span className="text-[10px] text-slate-500 mt-0.5 block">Cut trade on loss hit</span>
            </div>

            <div>
              <label className="label">Max Hold Period (Bars)</label>
              <input
                type="number"
                min={2}
                max={60}
                className="input mono py-1 text-xs"
                value={btHoldingBars}
                onChange={(e) => setBtHoldingBars(Number(e.target.value) || 16)}
              />
              <span className="text-[10px] text-slate-500 mt-0.5 block">Exit on timeout</span>
            </div>
          </div>

          {/* Backtest Results Presentation */}
          {btResult && (
            <div className="space-y-4 pt-2 border-t border-[#1f2937]">
              {/* Summary Metric Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 text-center">
                <Cell label="Win Rate" value={`${btResult.winRate}%`} cls={btResult.winRate >= 50 ? "up" : "down"} note={`${btResult.winningTrades}W / ${btResult.losingTrades}L`} />
                <Cell label="Total P&L" value={`₹${fmt(btResult.totalPnl)}`} cls={btResult.totalPnl >= 0 ? "up" : "down"} note={`On ₹${fmt(btResult.capitalUsed, 0)} cap`} />
                <Cell label="Return on Cap" value={`${btResult.returnOnCapital}%`} cls={btResult.returnOnCapital >= 0 ? "up" : "down"} />
                <Cell label="Profit Factor" value={String(btResult.profitFactor)} cls={btResult.profitFactor >= 1.5 ? "up" : ""} />
                <Cell label="Max Drawdown" value={`₹${fmt(btResult.maxDrawdown)}`} cls="down" note={`${btResult.maxDrawdownPct}% of equity`} />
                <Cell label="Total Trades" value={String(btResult.totalTrades)} note={`Avg: ₹${fmt(btResult.avgPnl)}/tr`} />
              </div>

              {/* Equity Curve SVG & Trade Log Preview */}
              <div className="grid lg:grid-cols-3 gap-4">
                {/* Equity Curve */}
                <div className="panel p-3 bg-[#0d1320] border-[#263244]">
                  <div className="flex items-center justify-between text-xs mb-1 font-bold">
                    <span className="text-slate-300">Equity Growth Curve</span>
                    <span className={`mono ${btResult.totalPnl >= 0 ? "up" : "down"}`}>
                      {btResult.totalPnl >= 0 ? "+" : ""}₹{fmt(btResult.totalPnl)}
                    </span>
                  </div>
                  {equitySvg && (
                    <svg viewBox={`0 0 ${equitySvg.w} ${equitySvg.h}`} className="w-full h-28 my-1" preserveAspectRatio="none">
                      <path d={equitySvg.line} stroke={btResult.totalPnl >= 0 ? "#22c55e" : "#ef4444"} strokeWidth="1.2" fill="none" />
                    </svg>
                  )}
                  <div className="flex justify-between text-[10px] text-slate-500 mono pt-1 border-t border-[#1f2937]">
                    <span>Start: ₹{fmt(btResult.capitalUsed, 0)}</span>
                    <span>Peak: ₹{fmt(btResult.capitalUsed + Math.max(0, btResult.totalPnl), 0)}</span>
                  </div>
                </div>

                {/* Historical Trades Log Table */}
                <div className="lg:col-span-2 panel overflow-hidden bg-[#0d1320] border-[#263244] flex flex-col">
                  <div className="p-2.5 px-3 border-b border-[#1f2937] flex items-center justify-between text-xs font-bold">
                    <span className="text-slate-300">Simulated Trades Log ({btResult.trades.length})</span>
                    <button
                      className="btn btn-xs btn-green py-0.5"
                      onClick={downloadBacktestExcel}
                      disabled={btDownloading}
                    >
                      ⤓ Download Full Excel
                    </button>
                  </div>
                  <div className="overflow-x-auto max-h-52">
                    <table className="tbl w-full text-xs">
                      <thead className="sticky top-0 bg-[#111827]">
                        <tr>
                          <th>#</th>
                          <th>Entry Time</th>
                          <th>Exit Time</th>
                          <th>Entry Spot</th>
                          <th>Exit Spot</th>
                          <th>Net P&amp;L</th>
                          <th>Exit Reason</th>
                          <th>Bars</th>
                        </tr>
                      </thead>
                      <tbody>
                        {btResult.trades.map((t) => (
                          <tr key={t.id}>
                            <td className="mono text-slate-500">{t.id}</td>
                            <td className="mono text-[11px]">{t.entryTime}</td>
                            <td className="mono text-[11px]">{t.exitTime}</td>
                            <td className="mono">{fmt(t.entrySpot)}</td>
                            <td className="mono">{fmt(t.exitSpot)}</td>
                            <td className={`mono font-bold ${t.pnl >= 0 ? "up" : "down"}`}>
                              {t.pnl >= 0 ? "+" : ""}₹{fmt(t.pnl)}
                            </td>
                            <td>
                              <span
                                className={`badge ${
                                  t.exitReason === "TARGET"
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : t.exitReason === "STOPLOSS"
                                    ? "bg-red-500/20 text-red-300"
                                    : "bg-slate-700 text-slate-400"
                                }`}
                              >
                                {t.exitReason}
                              </span>
                            </td>
                            <td className="mono text-slate-400">{t.durationBars}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Saved strategies */}
      <div className="panel p-4">
        <h2 className="font-bold mb-3">Built Strategies</h2>
        {saved.length === 0 ? (
          <div className="text-xs text-slate-500 border border-dashed border-[#263244] rounded-lg p-4 text-center">No strategies yet — build one above.</div>
        ) : (
          <div className="space-y-2">
            {saved.map((st) => (
              <div key={st.id} className="rounded-lg border border-[#263244] bg-[#0b1220] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{st.name}</span>
                  <span className="badge bg-slate-700/50 text-slate-300">{st.template}</span>
                  <span className="badge bg-slate-700/50 text-slate-300">
                    {st.underlying} · {st.expiry} · {st.lots} lot × {st.lotSize}
                  </span>
                  <span
                    className={`badge ${
                      st.status === "ENTERED" ? "bg-sky-500/20 text-sky-300" : st.status === "ACTIVE" ? "bg-amber-500/20 text-amber-300" : st.status === "EXITED" ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-500/20 text-slate-300"
                    }`}
                  >
                    {st.status}
                  </span>
                  <span className={`mono ml-auto font-bold ${st.combinedPnl > 0 ? "up" : st.combinedPnl < 0 ? "down" : ""}`}>₹{fmt(st.combinedPnl)}</span>
                </div>
                <div className="mt-2 grid md:grid-cols-2 gap-2 text-xs">
                  <div className="text-slate-400">
                    Net premium <span className={`mono ${st.netPremium >= 0 ? "up" : "down"}`}>₹{fmt(st.netPremium)}</span> · Max P <span className="up mono">₹{fmt(st.maxProfit)}</span> · Max L{" "}
                    <span className="down mono">₹{fmt(st.maxLoss)}</span> · BE {(st.breakevens ?? []).join(" / ") || "—"}
                  </div>
                  <div className="text-slate-400">
                    Margin <span className="mono">₹{fmt(st.marginRequired, 0)}</span> · Legs {st.legs.length} · Open {st.openLegs}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  {st.legs.map((l) => (
                    <span key={l.id} className="badge bg-slate-800/70 text-slate-300">
                      {l.name.split("·").pop()?.trim()} · {l.side} · {l.quantity} · {l.status}
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {st.status !== "ENTERED" && st.status !== "EXITED" && (
                    <button className="btn btn-xs" onClick={() => act(st.id, "arm")}>
                      ▶ Arm all
                    </button>
                  )}
                  {st.status !== "ENTERED" && st.status !== "EXITED" && (
                    <button className="btn btn-xs btn-green" onClick={() => act(st.id, "enter")}>
                      ENTER all legs
                    </button>
                  )}
                  {st.openLegs > 0 && (
                    <button className="btn btn-xs btn-red" onClick={() => act(st.id, "exit")}>
                      EXIT all legs
                    </button>
                  )}
                  <button className="btn btn-xs" onClick={() => act(st.id, "reset")}>
                    ↺ Reset
                  </button>
                  {st.openLegs === 0 && (
                    <button className="btn btn-xs" onClick={() => del(st.id)}>
                      🗑 Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Cell({ label, value, cls = "", note }: { label: string; value: string; cls?: string; note?: string }) {
  return (
    <div className="rounded bg-[#111827] border border-[#1f2937] py-1.5">
      <div className="text-[9px] text-slate-500 uppercase">{label}</div>
      <div className={`mono text-sm font-bold ${cls}`}>{value}</div>
      {note && <div className="text-[9px] text-slate-500">{note}</div>}
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
