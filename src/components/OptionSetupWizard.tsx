"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt } from "./utils";
import { toast } from "./Toast";
import { labelExpiries, type ExpiryInfo } from "@/lib/expiry-labels";
import type { SetupDraft } from "./SetupForm";

type ChainLeg = { ltp: number; iv: number; delta: number; oi: number; token?: string; tradingSymbol?: string; key?: string };
type ChainRow = { strike: number; ce: ChainLeg; pe: ChainLeg };
type Chain = {
  underlying: string;
  lotSize: number;
  spot: { ltp: number; changePct: number; source?: string };
  expiry: string;
  expiries: string[];
  atm: number;
  step: number;
  pcr: number;
  maxPain: number;
  chain: ChainRow[];
  live: { realContracts: boolean } | null;
};

const UNDERLYINGS = [
  { sym: "NIFTY", label: "NIFTY" },
  { sym: "SENSEX", label: "SENSEX" },
  { sym: "BANKNIFTY", label: "BANKNIFTY" },
  { sym: "FINNIFTY", label: "FINNIFTY" },
  { sym: "MIDCPNIFTY", label: "MIDCPNIFTY" },
  { sym: "BTCUSD", label: "₿ BTC" },
  { sym: "ETHUSD", label: "Ξ ETH" },
];

/** Option Chain Setup wizard — index pasand karo → expiry (This Week / Monthly) → strike → CE/PE → BUY/SELL → lots → setup. */
export function OptionSetupWizard({ onPick, onClose }: { onPick: (draft: SetupDraft) => void; onClose: () => void }) {
  const [underlying, setUnderlying] = useState("NIFTY");
  const [expiry, setExpiry] = useState("");
  const [data, setData] = useState<Chain | null>(null);
  const [loading, setLoading] = useState(false);
  const [strike, setStrike] = useState<number | null>(null);
  const [otype, setOtype] = useState<"CE" | "PE">("CE");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [lots, setLots] = useState(1);
  const [autoLevels, setAutoLevels] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ underlying, strikes: "8" });
      if (expiry) p.set("expiry", expiry);
      const r = await api<Chain>(`/api/options-chain?${p}`);
      setData(r);
      if (!expiry || !r.expiries.includes(expiry)) setExpiry(r.expiry);
      setStrike((s) => (s != null && r.chain.some((c) => c.strike === s) ? s : r.atm));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [underlying, expiry]);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const expiries: ExpiryInfo[] = useMemo(() => labelExpiries(data?.expiries ?? []), [data]);
  const isCrypto = underlying.endsWith("USD");
  const lotSize = isCrypto ? 1 : data?.lotSize ?? 1;
  const row = data?.chain.find((c) => c.strike === strike) ?? null;
  const leg = row ? (otype === "CE" ? row.ce : row.pe) : null;
  const premium = leg?.ltp ?? 0;
  const qty = lots * lotSize;
  const cur = isCrypto ? "$" : "₹";
  const cost = premium * qty;

  const moneyness = (k: number) => {
    const spot = data?.spot.ltp ?? 0;
    if (Math.abs(k - (data?.atm ?? 0)) < 0.001) return "ATM";
    const itm = otype === "CE" ? k < spot : k > spot;
    return itm ? "ITM" : "OTM";
  };

  const create = async () => {
    if (!data || !row || !leg) return;
    let auto: { stopLoss?: number; target?: number; support?: number; resistance?: number; basis?: string; riskReward?: number } = {};
    if (autoLevels) {
      try {
        auto = await api(`/api/option-levels?underlying=${underlying}&premium=${premium}&side=${side}&type=${otype}&strike=${row.strike}&spot=${data.spot.ltp}`);
      } catch {
        auto = { stopLoss: +(premium * (side === "BUY" ? 0.7 : 1.4)).toFixed(2), target: +(premium * (side === "BUY" ? 1.5 : 0.5)).toFixed(2) };
      }
    }
    const info = expiries.find((e) => e.date === expiry);
    onPick({
      name: `${underlying} ${row.strike} ${otype} ${side} · ${info?.label ?? expiry}${info?.monthly ? " (Monthly)" : ""} · ${lots} lot`,
      symbol: leg.tradingSymbol ?? `${underlying}${expiry.replace(/-/g, "").slice(2)}${row.strike}${otype}`,
      brokerToken: leg.token ?? "",
      underlying,
      exchange: isCrypto ? "DELTA" : underlying === "SENSEX" || underlying === "BANKEX" ? "BSE" : "NSE",
      segment: isCrypto ? "CRYPTO" : "OPT",
      instrumentType: otype,
      strike: row.strike,
      expiry,
      side,
      quantity: isCrypto ? lots : qty,
      productType: "NRML",
      orderType: "MARKET",
      entryPrice: premium,
      stopLoss: auto.stopLoss,
      target: auto.target,
      notes: `Option wizard: ${moneyness(row.strike)} · IV ${leg.iv}% · Δ ${leg.delta} · OI ${leg.oi.toLocaleString("en-IN")}${auto.basis ? ` · Auto levels: ${auto.basis} · R:R 1:${auto.riskReward}` : ""}${auto.support ? ` · Spot S/R ${auto.support}/${auto.resistance}` : ""}`,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-2xl p-5 mt-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold">⛓ Option Chain Setup</h2>
            <p className="text-xs text-slate-400">
              Index → Expiry → Strike → CE/PE → Lots — badhu ek j jagya par
              {data && (
                <>
                  {" "}· Spot <span className="mono text-sky-300">{fmt(data.spot.ltp)}</span>
                  <span className={`ml-1 ${data.spot.changePct >= 0 ? "up" : "down"}`}>({data.spot.changePct}%)</span>
                  {data.live?.realContracts && <span className="badge bg-emerald-500/20 text-emerald-300 ml-1">LIVE</span>}
                </>
              )}
            </p>
          </div>
          <button className="btn btn-xs" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 1. underlying */}
        <div className="mb-3">
          <label className="label">1 · Index / Underlying</label>
          <div className="flex flex-wrap gap-1.5">
            {UNDERLYINGS.map((u) => (
              <button
                key={u.sym}
                className={`btn btn-xs ${underlying === u.sym ? "btn-primary" : ""}`}
                onClick={() => {
                  setUnderlying(u.sym);
                  setExpiry("");
                  setStrike(null);
                  setLots(1);
                }}
              >
                {u.label}
              </button>
            ))}
          </div>
        </div>

        {/* 2. expiry */}
        <div className="mb-3">
          <label className="label">2 · Expiry</label>
          <div className="flex flex-wrap gap-1.5">
            {expiries.slice(0, 7).map((x) => (
              <button key={x.date} className={`btn btn-xs ${expiry === x.date ? "btn-primary" : ""}`} onClick={() => setExpiry(x.date)} title={`${x.date} (${x.dow}) · ${x.daysLeft} din baki`}>
                {x.label === "This Week" || x.label === "Today" ? "📅 " : ""}
                {x.label}
                {x.monthly && <span className="ml-1 badge bg-violet-500/20 text-violet-300">M</span>}
                <span className="ml-1 text-[9px] opacity-70">
                  {x.date.slice(5)} {x.dow}
                </span>
              </button>
            ))}
            {!expiries.length && <span className="text-xs text-slate-500">{loading ? "Loading…" : "—"}</span>}
          </div>
        </div>

        {/* 3. strike table */}
        <div className="mb-3">
          <label className="label">3 · Strike ane CE / PE</label>
          <div className="flex gap-1.5 mb-1.5">
            <button className={`btn btn-xs flex-1 ${otype === "CE" ? "btn-green" : ""}`} onClick={() => setOtype("CE")}>
              CALL (CE)
            </button>
            <button className={`btn btn-xs flex-1 ${otype === "PE" ? "btn-red" : ""}`} onClick={() => setOtype("PE")}>
              PUT (PE)
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-[#263244]">
            <table className="tbl w-full">
              <thead className="sticky top-0 bg-[#111827]">
                <tr>
                  <th>Strike</th>
                  <th></th>
                  <th>LTP</th>
                  <th>IV</th>
                  <th>Δ</th>
                  <th>OI</th>
                </tr>
              </thead>
              <tbody>
                {(data?.chain ?? []).map((r) => {
                  const l = otype === "CE" ? r.ce : r.pe;
                  const sel = strike === r.strike;
                  const m = moneyness(r.strike);
                  return (
                    <tr key={r.strike} className={`cursor-pointer ${sel ? "bg-sky-500/15" : ""}`} onClick={() => setStrike(r.strike)}>
                      <td className={`mono font-bold ${r.strike === data?.atm ? "text-sky-300" : ""}`}>
                        {sel ? "● " : ""}
                        {r.strike}
                      </td>
                      <td>
                        <span className={`badge ${m === "ATM" ? "bg-sky-500/20 text-sky-300" : m === "ITM" ? "bg-amber-500/20 text-amber-300" : "bg-slate-600/30 text-slate-400"}`}>{m}</span>
                      </td>
                      <td className="mono">{fmt(l.ltp)}</td>
                      <td className="mono text-[11px]">{l.iv}%</td>
                      <td className="mono text-[11px]">{l.delta}</td>
                      <td className="mono text-[11px]">{l.oi.toLocaleString("en-IN")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* 4. side + lots */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 items-end">
          <div>
            <label className="label">4 · Buy / Sell</label>
            <div className="flex gap-1">
              <button className={`btn flex-1 ${side === "BUY" ? "btn-green" : ""}`} onClick={() => setSide("BUY")}>
                BUY
              </button>
              <button className={`btn flex-1 ${side === "SELL" ? "btn-red" : ""}`} onClick={() => setSide("SELL")}>
                SELL
              </button>
            </div>
          </div>
          <div>
            <label className="label">5 · Lots (1 lot = {lotSize})</label>
            <div className="flex gap-1">
              <button className="btn btn-xs" onClick={() => setLots(Math.max(1, lots - 1))}>
                −
              </button>
              <input className="input mono text-center" type="number" min={1} max={500} value={lots} onChange={(e) => setLots(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
              <button className="btn btn-xs" onClick={() => setLots(lots + 1)}>
                ＋
              </button>
            </div>
            <div className="flex gap-1 mt-1">
              {[1, 2, 5, 10].map((n) => (
                <button key={n} className={`btn btn-xs flex-1 ${lots === n ? "btn-primary" : ""}`} onClick={() => setLots(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="col-span-2">
            <label className="label">Summary</label>
            <div className="rounded-lg border border-[#263244] bg-[#0b1220] p-2.5 text-xs mono space-y-0.5">
              <div className="flex justify-between">
                <span className="text-slate-500">Contract</span>
                <span className="font-bold">
                  {underlying} {strike} {otype} · {expiries.find((e) => e.date === expiry)?.label ?? expiry}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Qty</span>
                <span>
                  {lots} lot × {lotSize} = {isCrypto ? lots : qty}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Premium {side === "BUY" ? "(debit)" : "(credit)"}</span>
                <span className={side === "BUY" ? "down" : "up"}>
                  {cur}
                  {fmt(premium)} × {isCrypto ? lots : qty} = {cur}
                  {fmt(isCrypto ? premium * lots : cost)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs mb-3">
          <input type="checkbox" checked={autoLevels} onChange={(e) => setAutoLevels(e.target.checked)} />
          ⚡ Auto SL / Target / S-R bhari do (ATR + delta based)
        </label>

        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!row || !leg || loading} onClick={create}>
            Setup banavo → ({side} {strike} {otype}, {lots} lot)
          </button>
        </div>
      </div>
    </div>
  );
}
