"use client";

import { useEffect, useState } from "react";
import type { Broker, Setup } from "@/db/schema";
import { api, providerName } from "./utils";
import { toast } from "./Toast";

const fmtNum = (n: number) => Math.round(n).toLocaleString("en-IN");

export type SetupDraft = Partial<Setup> & { symbol: string };

const EXCHANGES = ["NSE", "BSE", "MCX", "CDS", "DELTA"];
const SEGMENTS = ["EQ", "INDEX", "FUT", "OPT", "COMMODITY", "CURRENCY", "CRYPTO"];
const INSTRUMENT_TYPES = ["EQ", "FUT", "CE", "PE"];

export function SetupForm({ initial, onClose, onSaved }: { initial: SetupDraft; onClose: () => void; onSaved: (s: Setup) => void }) {
  const isEdit = !!initial.id;
  const [f, setF] = useState<SetupDraft>({
    name: "",
    underlying: "",
    exchange: "NSE",
    segment: "EQ",
    instrumentType: "EQ",
    side: "BUY",
    quantity: 1,
    productType: "MIS",
    orderType: "MARKET",
    entryTrigger: "MANUAL",
    expiry: "",
    brokerToken: "",
    notes: "",
    ...initial,
  });
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [ltp, setLtp] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [cap, setCap] = useState<{ total: number; free: number; riskPct: number } | null>(null);
  const [autoInfo, setAutoInfo] = useState<string>("");

  useEffect(() => {
    api<Broker[]>("/api/brokers").then((b) => {
      setBrokers(b);
      const isCrypto = f.exchange === "DELTA" || f.segment === "CRYPTO" || f.symbol?.endsWith("USD");
      if (!f.brokerId) {
        if (isCrypto) {
          const delta = b.find((x) => x.provider === "deltaexchange");
          if (delta) setF((s) => ({ ...s, brokerId: delta.id }));
          else {
            const d = b.find((x) => x.isDefault) ?? b[0];
            if (d) setF((s) => ({ ...s, brokerId: d.id }));
          }
        } else {
          const indian = b.find((x) => x.isDefault && x.provider !== "deltaexchange") ?? b.find((x) => x.provider !== "deltaexchange") ?? b[0];
          if (indian) setF((s) => ({ ...s, brokerId: indian.id }));
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!brokers.length) return;
    const isCrypto = f.exchange === "DELTA" || f.segment === "CRYPTO" || f.symbol?.endsWith("USD");
    const currentBroker = brokers.find((b) => b.id === f.brokerId);
    const currentIsCrypto = currentBroker?.provider === "deltaexchange";

    if (isCrypto && !currentIsCrypto) {
      const delta = brokers.find((b) => b.provider === "deltaexchange");
      if (delta) setF((s) => ({ ...s, brokerId: delta.id }));
    } else if (!isCrypto && currentIsCrypto) {
      const indian = brokers.find((b) => b.isDefault && b.provider !== "deltaexchange") ?? brokers.find((b) => b.provider !== "deltaexchange");
      if (indian) setF((s) => ({ ...s, brokerId: indian.id }));
    }
  }, [f.exchange, f.segment, f.symbol, brokers, f.brokerId]);

  const [lotSize, setLotSize] = useState(1);
  useEffect(() => {
    api<{ snapshot: { capital: number; freeMargin: number; settings: { riskPerTradePct: number } } }>("/api/settings")
      .then((r) => setCap({ total: r.snapshot.capital, free: r.snapshot.freeMargin, riskPct: r.snapshot.settings.riskPerTradePct }))
      .catch(() => setCap(null));
  }, []);

  useEffect(() => {
    const sym = (f.underlying || f.symbol || "").toUpperCase();
    if (!sym) return;
    api<Record<string, { ltp: number }>>(`/api/quotes?symbols=${sym}`).then((q) => setLtp(q[sym]?.ltp ?? null)).catch(() => setLtp(null));
    api<{ items: { symbol: string; lotSize: number }[] }>(`/api/instruments?q=${encodeURIComponent(sym)}&limit=20`)
      .then((r) => setLotSize(r.items.find((i) => i.symbol === sym)?.lotSize ?? 1))
      .catch(() => setLotSize(1));
  }, [f.underlying, f.symbol]);
  
  const usesLots = f.instrumentType !== "EQ" && lotSize > 1;
  const lots = usesLots ? Math.max(1, Math.round((f.quantity ?? lotSize) / lotSize)) : 0;

  const set = (k: keyof SetupDraft, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  const isOpt = f.instrumentType === "CE" || f.instrumentType === "PE";

  const ref = f.entryPrice || ltp || 0;
  const quickSl = (pct: number) => set("stopLoss", +(f.side === "BUY" ? ref * (1 - pct / 100) : ref * (1 + pct / 100)).toFixed(2));
  const quickTg = (pct: number) => set("target", +(f.side === "BUY" ? ref * (1 + pct / 100) : ref * (1 - pct / 100)).toFixed(2));

  const save = async (andActivate = false) => {
    if (!f.name || !f.symbol) return toast("Name and symbol required", "error");
    setSaving(true);
    try {
      const payload = { ...f, quantity: usesLots ? lots * lotSize : f.quantity, status: andActivate ? "ACTIVE" : f.status ?? "DRAFT" };
      const saved = isEdit ? await api<Setup>(`/api/setups/${f.id}`, { method: "PUT", body: JSON.stringify(payload) }) : await api<Setup>("/api/setups", { method: "POST", body: JSON.stringify(payload) });
      toast(isEdit ? "Setup updated" : andActivate ? "Setup created & armed" : "Setup saved as draft", "success");
      onSaved(saved);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-3xl p-5 mt-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold">{isEdit ? "Edit Algo Setup" : "New Algo Setup"}</h2>
            <p className="text-xs text-slate-400">
              Entry / Exit rules for <span className="font-semibold text-slate-200">{f.symbol || "—"}</span>
              {ltp != null && (
                <>
                  {" "}· Spot <span className="mono text-sky-300">₹{ltp}</span>
                </>
              )}
              {f.status && (
                <>
                  {" "}· Status <span className="font-semibold">{f.status}</span>
                </>
              )}
            </p>
          </div>
          <button className="btn btn-xs" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="col-span-2">
            <label className="label">Setup Name</label>
            <input className="input" value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="e.g. NIFTY 24800 CE Breakout" />
          </div>
          <div>
            <label className="label">
              Broker {f.exchange === "DELTA" || f.segment === "CRYPTO" ? "(Auto: ₿ Crypto)" : "(Auto: 🇮🇳 Indian)"}
            </label>
            <select className="input" value={f.brokerId ?? ""} onChange={(e) => set("brokerId", e.target.value ? Number(e.target.value) : null)}>
              <option value="">Auto Broker / Paper</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.provider === "deltaexchange" ? "₿ Crypto" : "🇮🇳 Indian"} · {b.label} · {b.mode.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Side</label>
            <div className="flex gap-1">
              {["BUY", "SELL"].map((s) => (
                <button key={s} className={`btn flex-1 ${f.side === s ? (s === "BUY" ? "btn-green" : "btn-red") : ""}`} onClick={() => set("side", s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label">Symbol / Trading Symbol</label>
            <input className="input mono" value={f.symbol} onChange={(e) => set("symbol", e.target.value.toUpperCase())} placeholder="RELIANCE" />
          </div>
          <div>
            <label className="label">Underlying (for F&O)</label>
            <input className="input mono" value={f.underlying ?? ""} onChange={(e) => set("underlying", e.target.value.toUpperCase())} placeholder="NIFTY" />
          </div>
          <div>
            <label className="label">Exchange</label>
            <select className="input" value={f.exchange} onChange={(e) => set("exchange", e.target.value)}>
              {EXCHANGES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Segment</label>
            <select className="input" value={f.segment} onChange={(e) => set("segment", e.target.value)}>
              {SEGMENTS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Instrument</label>
            <select className="input" value={f.instrumentType} onChange={(e) => set("instrumentType", e.target.value)}>
              {INSTRUMENT_TYPES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Strike {isOpt ? "" : "(options)"}</label>
            <input className="input mono" type="number" disabled={!isOpt} value={f.strike ?? ""} onChange={(e) => set("strike", e.target.value === "" ? null : Number(e.target.value))} />
          </div>
          <div>
            <label className="label">Expiry</label>
            <input className="input mono" type="date" disabled={f.instrumentType === "EQ"} value={f.expiry ?? ""} onChange={(e) => set("expiry", e.target.value)} />
          </div>
          <div>
            {usesLots ? (
              <>
                <label className="label">Lots (1 lot = {lotSize})</label>
                <div className="flex gap-1">
                  <button className="btn btn-xs" onClick={() => set("quantity", Math.max(1, lots - 1) * lotSize)}>−</button>
                  <input className="input mono text-center" type="number" min={1} value={lots} onChange={(e) => set("quantity", Math.max(1, Number(e.target.value) || 1) * lotSize)} />
                  <button className="btn btn-xs" onClick={() => set("quantity", (lots + 1) * lotSize)}>+</button>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5 mono">Qty = {lots} × {lotSize} = {lots * lotSize}</div>
              </>
            ) : (
              <>
                <label className="label">Quantity (units)</label>
                <input className="input mono" type="number" min={1} value={f.quantity ?? 1} onChange={(e) => set("quantity", Number(e.target.value))} />
              </>
            )}
          </div>

          <div>
            <label className="label">Product</label>
            <select className="input" value={f.productType} onChange={(e) => set("productType", e.target.value)}>
              <option value="MIS">MIS (Intraday)</option>
              <option value="CNC">CNC (Delivery)</option>
              <option value="NRML">NRML (Carry F&O)</option>
            </select>
          </div>
          <div>
            <label className="label">Order Type</label>
            <select className="input" value={f.orderType} onChange={(e) => set("orderType", e.target.value)}>
              <option>MARKET</option>
              <option>LIMIT</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">Broker Token (securityId / symboltoken / neo tsym)</label>
            <input className="input mono" value={f.brokerToken ?? ""} onChange={(e) => set("brokerToken", e.target.value)} placeholder="Required for LIVE orders, e.g. 2885 / 26000" />
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-[#263244] bg-[#0b1220] p-3">
          <div className="text-xs font-bold text-slate-300 mb-2">ENTRY RULE</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="col-span-2">
              <label className="label">Entry Trigger</label>
              <select className="input" value={f.entryTrigger} onChange={(e) => set("entryTrigger", e.target.value)}>
                <option value="MANUAL">Manual — I click ENTER</option>
                <option value="PRICE_ABOVE">Auto — when LTP ≥ Entry Price (breakout)</option>
                <option value="PRICE_BELOW">Auto — when LTP ≤ Entry Price (breakdown/dip)</option>
                <option value="RSI_CROSS_BUY">⚡ Auto — RSI Crossover BUY (Crosses above 30 or 50)</option>
                <option value="RSI_CROSS_SELL">⚡ Auto — RSI Crossover SELL (Crosses below 70 or 50)</option>
                <option value="EMA_CROSS_BUY">⚡ Auto — EMA 9/21 Cross (BUY - 1 Candle Close)</option>
                <option value="EMA_CROSS_SELL">⚡ Auto — EMA 9/21 Cross (SELL - 1 Candle Close)</option>
                <option value="ORB_BUY">🌅 Auto — 15m ORB Breakout (BUY above 1st Candle High)</option>
                <option value="ORB_SELL">🌅 Auto — 15m ORB Breakdown (SELL below 1st Candle Low)</option>
              </select>
            </div>
            <div>
              <label className="label">Entry Price</label>
              <input className="input mono" type="number" step="0.05" value={f.entryPrice ?? ""} onChange={(e) => set("entryPrice", e.target.value === "" ? null : Number(e.target.value))} placeholder={ltp ? String(ltp) : ""} />
            </div>
            <div className="flex items-end">
              <button className="btn w-full" onClick={() => ltp && set("entryPrice", ltp)}>
                Use LTP
              </button>
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-[#263244] bg-[#0b1220] p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-slate-300">EXIT RULES (auto-monitored by engine)</div>
            <button
              className="btn btn-xs btn-primary"
              onClick={async () => {
                try {
                  if (isOpt && (f.underlying || f.symbol)) {
                    const prem = f.entryPrice || ltp || 0;
                    const r = await api<{ stopLoss: number; target: number; support: number; resistance: number; riskReward: number; basis: string; atr: number }>(
                      `/api/option-levels?underlying=${(f.underlying || f.symbol).toUpperCase()}&premium=${prem}&side=${f.side}&type=${f.instrumentType}&strike=${f.strike ?? 0}`,
                    );
                    set("stopLoss", r.stopLoss);
                    set("target", r.target);
                    setAutoInfo(`Auto ✓ SL ${r.stopLoss} · Target ${r.target} · R:R 1:${r.riskReward} · Spot S/R ${r.support}/${r.resistance} · ${r.basis}`);
                    toast(`Auto levels set — SL ${r.stopLoss}, Target ${r.target} (R:R 1:${r.riskReward})`, "success");
                  } else {
                    const sym = (f.underlying || f.symbol || "").toUpperCase();
                    const r = await api<{ signal: { levels: { stopLoss: number; target: number; support: number; resistance: number; riskReward: number; atr: number } } | null }>(
                      `/api/candles?symbol=${sym}&interval=15m`,
                    );
                    if (!r.signal) throw new Error("Not enough candle data");
                    const L = r.signal.levels;
                    const buy = f.side === "BUY";
                    set("stopLoss", buy ? L.stopLoss : L.target);
                    set("target", buy ? L.target : L.stopLoss);
                    setAutoInfo(`Auto ✓ ATR ${L.atr} · S/R ${L.support}/${L.resistance} · R:R 1:${L.riskReward}`);
                    toast("Auto SL/Target set from ATR + S/R", "success");
                  }
                } catch (e) {
                  toast((e as Error).message, "error");
                }
              }}
            >
              ⚡ Auto SL · Target · S/R
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="label">Stop Loss (price)</label>
              <input className="input mono" type="number" step="0.05" value={f.stopLoss ?? ""} onChange={(e) => set("stopLoss", e.target.value === "" ? null : Number(e.target.value))} />
              <div className="flex gap-1 mt-1">
                {[0.5, 1, 2, 5].map((p) => (
                  <button key={p} className="btn btn-xs flex-1" onClick={() => quickSl(p)}>
                    {p}%
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Target (price)</label>
              <input className="input mono" type="number" step="0.05" value={f.target ?? ""} onChange={(e) => set("target", e.target.value === "" ? null : Number(e.target.value))} />
              <div className="flex gap-1 mt-1">
                {[1, 2, 5, 10].map((p) => (
                  <button key={p} className="btn btn-xs flex-1" onClick={() => quickTg(p)}>
                    {p}%
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Trailing SL (points)</label>
              <input className="input mono" type="number" step="0.05" value={f.trailingSl ?? ""} onChange={(e) => set("trailingSl", e.target.value === "" ? null : Number(e.target.value))} placeholder="e.g. 20" />
              <div className="text-[10px] text-slate-500 mt-1">Stop trails LTP by these points once entered.</div>
            </div>
          </div>
          {autoInfo && <div className="mt-2 text-[10px] text-emerald-300/90 mono leading-relaxed">{autoInfo}</div>}
          {ref > 0 && (f.stopLoss || f.target) && (
            <div className="mt-2 text-xs text-slate-400 mono">
              Risk: {f.stopLoss ? `₹${(Math.abs(ref - f.stopLoss) * (f.quantity ?? 1)).toFixed(0)}` : "—"} · Reward: {f.target ? `₹${(Math.abs(f.target - ref) * (f.quantity ?? 1)).toFixed(0)}` : "—"}
              {f.stopLoss && f.target ? ` · R:R 1:${(Math.abs(f.target - ref) / Math.max(Math.abs(ref - f.stopLoss), 0.01)).toFixed(2)}` : ""}
            </div>
          )}
        </div>

        {cap && ltp != null && (
          <div className="mt-3 rounded-lg border border-[#263244] bg-[#0b1220] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-bold text-slate-300">Capital &amp; Risk (₹{cap.total.toLocaleString("en-IN")})</div>
              <button
                className="btn btn-xs"
                onClick={async () => {
                  if (!f.stopLoss) return toast("Set a stop loss first to auto-size", "error");
                  try {
                    const r = await api<{ quantity: number; lots: number; riskAmount: number }>(`/api/settings`, {
                      method: "POST",
                      body: JSON.stringify({ entry: f.entryPrice || ltp, stopLoss: f.stopLoss, lotSize, instrumentType: f.instrumentType }),
                    });
                    set("quantity", r.quantity);
                    toast(`Sized by risk: ${f.instrumentType === "EQ" ? `${r.quantity} qty` : `${r.lots} lot (${r.quantity} qty)`} · risk ₹${r.riskAmount}`, "success");
                  } catch (e) {
                    toast((e as Error).message, "error");
                  }
                }}
              >
                ⚖ Auto qty by risk ({cap.riskPct}%)
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div>
                <div className="text-slate-500">Margin needed</div>
                <div className="mono font-bold">{f.instrumentType === "EQ" ? (f.productType === "CNC" ? "₹" + fmtNum(ltp * (f.quantity ?? 1)) : f.productType === "NRML" ? "₹" + fmtNum(ltp * (f.quantity ?? 1) * 0.35) : "₹" + fmtNum(ltp * (f.quantity ?? 1) * 0.2)) : f.side === "BUY" ? "₹" + fmtNum(ltp * (f.quantity ?? 1)) : "₹" + fmtNum(ltp * (f.quantity ?? 1) * 0.12)}</div>
              </div>
              <div>
                <div className="text-slate-500">Free capital</div>
                <div className="mono font-bold up">₹{fmtNum(cap.free)}</div>
              </div>
              <div>
                <div className="text-slate-500">Risk at SL</div>
                <div className="mono font-bold down">{f.stopLoss ? "₹" + fmtNum(Math.abs((f.entryPrice || ltp) - f.stopLoss) * (f.quantity ?? 1)) : "—"}</div>
              </div>
              <div>
                <div className="text-slate-500">Reward at Tgt</div>
                <div className="mono font-bold up">{f.target ? "₹" + fmtNum(Math.abs(f.target - (f.entryPrice || ltp)) * (f.quantity ?? 1)) : "—"}</div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-3">
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="Strategy notes…" />
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={saving} onClick={() => save(false)}>
            {isEdit ? "Save Changes" : "Save Draft"}
          </button>
          {(!isEdit || f.status === "DRAFT" || f.status === "CANCELLED" || f.status === "EXITED") && (
            <button className="btn btn-primary" disabled={saving} onClick={() => save(true)}>
              {isEdit ? "Save & Arm" : "Create & Arm"} ▶
            </button>
          )}
        </div>
      </div>
    </div>
  );
}