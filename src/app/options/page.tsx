"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ChainRow, Quote } from "@/lib/market";
import { api, fmt, fmtOi } from "@/components/utils";
import { SetupForm, type SetupDraft } from "@/components/SetupForm";
import { useLiveTicks } from "@/components/useLiveTicks";
import { labelExpiries } from "@/lib/expiry-labels";
import { addOptionToWatchlist } from "@/lib/watchlist";
import { toast } from "@/components/Toast";

type Chain = {
  underlying: string;
  name: string;
  lotSize: number;
  spot: Quote;
  expiry: string;
  expiries: string[];
  step: number;
  atm: number;
  pcr: number;
  maxPain: number;
  totalCeOi: number;
  totalPeOi: number;
  chain: ChainRow[];
  underlyings: { symbol: string; name: string; segment: string; lotSize: number }[];
  live: { provider: string; liveLegs: number; totalLegs: number; realContracts: boolean } | null;
};

export default function OptionsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-400">Loading…</div>}>
      <OptionsInner />
    </Suspense>
  );
}

function OptionsInner() {
  const sp = useSearchParams();
  const [underlying, setUnderlying] = useState(sp.get("u")?.toUpperCase() || "NIFTY");
  const [expiry, setExpiry] = useState("");
  const [strikes, setStrikes] = useState(12);
  const [data, setData] = useState<Chain | null>(null);
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [showGreeks, setShowGreeks] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const p = new URLSearchParams({ underlying, strikes: String(strikes) });
    if (expiry) p.set("expiry", expiry);
    try {
      const r = await api<Chain>(`/api/options-chain?${p}`);
      setData(r);
      if (!expiry) setExpiry(r.expiry);
    } catch {
      /* ignore */
    }
  }, [underlying, expiry, strikes]);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const keyStr = data ? data.chain.flatMap((r) => [r.ce.key, r.pe.key]).filter(Boolean).join(",") : "";
  const { ticks } = useLiveTicks([data?.underlying ?? underlying], keyStr ? keyStr.split(",") : []);

  const openChart = (row: ChainRow, type: "CE" | "PE") => {
    if (!data) return;
    const leg = type === "CE" ? row.ce : row.pe;
    const isCrypto = data.underlying.endsWith("USD");
    const sym = isCrypto && leg.tradingSymbol ? leg.tradingSymbol : `${data.underlying}${row.strike}${type}`;
    const detail = isCrypto && leg.tradingSymbol
      ? { symbol: sym, option: null }
      : { symbol: sym, option: { underlying: data.underlying, strike: row.strike, otype: type, expiry } };
    // crypto contract symbols chart directly; NSE options chart via model params
    if (isCrypto && leg.tradingSymbol) {
      localStorage.setItem("algodesk.chartSymbol", leg.tradingSymbol);
      localStorage.removeItem("algodesk.chartOption");
    } else {
      localStorage.setItem("algodesk.chartSymbol", sym);
      localStorage.setItem("algodesk.chartOption", JSON.stringify(detail.option));
    }
    window.dispatchEvent(new CustomEvent("algodesk-open-chart", { detail }));
    window.location.href = "/";
  };

  const trade = async (row: ChainRow, type: "CE" | "PE", side: "BUY" | "SELL") => {
    if (!data) return;
    const leg = type === "CE" ? row.ce : row.pe;
    const isCrypto = data.underlying.endsWith("USD");
    const premium = (leg.key && ticks[leg.key]?.ltp) || leg.ltp;
    // automated SL / Target / S-R from underlying ATR & swings
    let auto: { stopLoss?: number; target?: number; support?: number; resistance?: number; basis?: string; riskReward?: number } = {};
    try {
      auto = await api(`/api/option-levels?underlying=${data.underlying}&premium=${premium}&side=${side}&type=${type}&strike=${row.strike}&spot=${ticks[data.underlying]?.ltp ?? data.spot.ltp}`);
    } catch {
      /* fallback: percentages */
      auto = { stopLoss: +(premium * (side === "BUY" ? 0.7 : 1.4)).toFixed(2), target: +(premium * (side === "BUY" ? 1.5 : 0.5)).toFixed(2) };
    }
    setDraft({
      name: `${data.underlying} ${row.strike} ${type} ${side}`,
      symbol: leg.tradingSymbol ?? `${data.underlying}${expiry.replace(/-/g, "").slice(2)}${row.strike}${type}`,
      brokerToken: leg.token ?? "",
      underlying: data.underlying,
      exchange: isCrypto ? "DELTA" : data.underlying === "SENSEX" || data.underlying === "BANKEX" ? "BSE" : "NSE",
      segment: isCrypto ? "CRYPTO" : "OPT",
      instrumentType: type,
      strike: row.strike,
      expiry,
      side,
      quantity: isCrypto ? 1 : data.lotSize,
      productType: "NRML",
      orderType: "MARKET",
      entryPrice: premium,
      stopLoss: auto.stopLoss,
      target: auto.target,
      notes: `Auto levels: ${auto.basis ?? "percent fallback"} · R:R 1:${auto.riskReward ?? "?"} · Spot S/R ${auto.support ?? "-"} / ${auto.resistance ?? "-"}`,
    });
  };

  const maxOi = data ? Math.max(...data.chain.map((r) => Math.max(r.ce.oi, r.pe.oi))) : 1;
  const filteredU = data?.underlyings.filter((u) => !search || u.symbol.includes(search.toUpperCase()) || u.name.toUpperCase().includes(search.toUpperCase())) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-bold">Options Chain</h1>
          <p className="text-xs text-slate-400">Index & stock options · NFO / BFO · Greeks · OI analysis · live spot from Yahoo Finance</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2 items-end">
          <div>
            <label className="label">Search</label>
            <input className="input w-36" placeholder="Filter list" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <label className="label">Underlying</label>
            <select
              className="input w-52"
              value={underlying}
              onChange={(e) => {
                setUnderlying(e.target.value);
                setExpiry("");
              }}
            >
              {filteredU.map((u) => (
                <option key={u.symbol} value={u.symbol}>
                  {u.symbol} — {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Expiry</label>
            <select className="input w-40" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {labelExpiries(data?.expiries ?? []).map((x) => (
                <option key={x.date} value={x.date}>
                  {x.date} · {x.label}{x.monthly ? " · Monthly" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Strikes</label>
            <select className="input w-20" value={strikes} onChange={(e) => setStrikes(Number(e.target.value))}>
              {[6, 10, 12, 16, 20, 30].map((n) => (
                <option key={n} value={n}>
                  ±{n}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs pb-2">
            <input type="checkbox" checked={showGreeks} onChange={(e) => setShowGreeks(e.target.checked)} /> Greeks
          </label>
        </div>
      </div>

      {data && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {labelExpiries(data.expiries).slice(0, 8).map((x) => (
              <button
                key={x.date}
                className={`btn btn-xs ${expiry === x.date ? "btn-primary" : ""}`}
                onClick={() => setExpiry(x.date)}
                title={`${x.date} (${x.dow}) · ${x.daysLeft} days left`}
              >
                {x.label === "This Week" || x.label === "Today" ? "📅 " : ""}{x.label}
                {x.monthly && <span className="ml-1 badge bg-violet-500/20 text-violet-300">M</span>}
                <span className="ml-1 text-[9px] opacity-70">{x.date.slice(5)} {x.dow}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
            <Stat label={data.underlying} value={fmt(ticks[data.underlying]?.ltp ?? data.spot.ltp)} sub={`${data.spot.change >= 0 ? "▲" : "▼"} ${fmt(Math.abs(data.spot.change))} (${data.spot.changePct}%)`} cls={data.spot.change >= 0 ? "up" : "down"} />
            <Stat label="ATM Strike" value={String(data.atm)} sub={`step ${data.step}`} />
            <Stat label="PCR (OI)" value={String(data.pcr)} sub={data.pcr > 1.2 ? "Bullish bias" : data.pcr < 0.8 ? "Bearish bias" : "Neutral"} cls={data.pcr > 1.2 ? "up" : data.pcr < 0.8 ? "down" : ""} />
            <Stat label="Max Pain" value={String(data.maxPain)} />
            <Stat label="Total CE OI" value={fmtOi(data.totalCeOi)} cls="down" />
            <Stat label="Total PE OI" value={fmtOi(data.totalPeOi)} cls="up" />
            <Stat label="Lot Size" value={String(data.lotSize)} sub={`${data.expiry} · ${data.live?.realContracts ? `LIVE ${data.live.liveLegs}/${data.live.totalLegs}` : data.spot.source === "live" ? "LIVE spot" : data.spot.source === "yahoo" ? "Yahoo 15m" : "Model"}`} />
          </div>

          <div className="panel overflow-x-auto">
            <table className="tbl text-center">
              <thead>
                <tr>
                  <th colSpan={showGreeks ? 9 : 6} className="text-center bg-green-500/5 text-green-300">
                    CALLS
                  </th>
                  <th className="text-center">STRIKE</th>
                  <th colSpan={showGreeks ? 9 : 6} className="text-center bg-red-500/5 text-red-300">
                    PUTS
                  </th>
                </tr>
                <tr>
                  <th></th>
                  <th>OI</th>
                  <th>Chg OI</th>
                  <th>Δ</th>
                  {showGreeks && (
                    <>
                      <th>Γ</th>
                      <th>Θ</th>
                      <th>Vega</th>
                    </>
                  )}
                  <th>IV</th>
                  <th>LTP</th>
                  <th></th>
                  <th>LTP</th>
                  <th>IV</th>
                  <th>Δ</th>
                  {showGreeks && (
                    <>
                      <th>Vega</th>
                      <th>Θ</th>
                      <th>Γ</th>
                    </>
                  )}
                  <th>Chg OI</th>
                  <th>OI</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.chain.map((r) => {
                  const isAtm = r.strike === data.atm;
                  const ceItm = r.strike < data.spot.ltp;
                  const peItm = r.strike > data.spot.ltp;
                  const ceT = r.ce.key ? ticks[r.ce.key] : undefined;
                  const peT = r.pe.key ? ticks[r.pe.key] : undefined;
                  return (
                    <tr key={r.strike} className={isAtm ? "bg-sky-500/10" : ""}>
                      <td>
                        <div className="flex gap-1 justify-center">
                          <button className="btn btn-xs btn-green" onClick={() => trade(r, "CE", "BUY")}>
                            B
                          </button>
                          <button className="btn btn-xs btn-red" onClick={() => trade(r, "CE", "SELL")}>
                            S
                          </button>
                          <button className="btn btn-xs" title="CE chart kholo" onClick={() => openChart(r, "CE")}>
                            📈
                          </button>
                          <button
                            className="btn btn-xs text-amber-300 hover:bg-amber-500/20"
                            title="Add CE Strike to Watchlist ⭐"
                            onClick={() => {
                              if (!data) return;
                              const res = addOptionToWatchlist({
                                underlying: data.underlying,
                                strike: r.strike,
                                otype: "CE",
                                expiry,
                                lotSize: data.lotSize,
                                token: r.ce.token,
                                tradingSymbol: r.ce.tradingSymbol,
                              });
                              toast(res.message, res.ok ? "success" : "info");
                            }}
                          >
                            ⭐
                          </button>
                        </div>
                      </td>
                      <td className={`mono relative ${ceItm ? "bg-amber-500/5" : ""}`}>
                        <div className="absolute inset-y-1 right-0 bg-green-500/15 rounded-l" style={{ width: `${(r.ce.oi / maxOi) * 100}%` }} />
                        <span className="relative">{fmtOi(r.ce.oi)}</span>
                      </td>
                      <td className={`mono text-[11px] ${ceItm ? "bg-amber-500/5" : ""} ${r.ce.oiChange >= 0 ? "up" : "down"}`}>{fmtOi(Math.abs(r.ce.oiChange))}</td>
                      <td className="mono text-[11px] text-sky-300">{r.ce.delta}</td>
                      {showGreeks && (
                        <>
                          <td className="mono text-[11px]">{r.ce.gamma}</td>
                          <td className="mono text-[11px]">{r.ce.theta}</td>
                          <td className="mono text-[11px]">{r.ce.vega}</td>
                        </>
                      )}
                      <td className={`mono text-[11px] ${ceItm ? "bg-amber-500/5" : ""}`}>{r.ce.iv}</td>
                      <td className={`mono font-semibold ${ceItm ? "bg-amber-500/5" : ""}`}>
                        <span key={ceT?.flashAt} className={`px-0.5 rounded ${ceT?.flashAt ? (ceT.dir === "up" ? "flash-up" : "flash-down") : ""}`}>{fmt(ceT?.ltp ?? r.ce.ltp)}</span>
                        {(r.ce.live || ceT) && <span className="text-[8px] text-emerald-400 align-top">●</span>}
                        <div className={`text-[10px] ${r.ce.change >= 0 ? "up" : "down"}`}>{r.ce.changePct}%</div>
                      </td>
                      <td className={`mono font-bold ${isAtm ? "text-sky-300" : "text-slate-200"} bg-[#0b1220]`}>{r.strike}</td>
                      <td className={`mono font-semibold ${peItm ? "bg-amber-500/5" : ""}`}>
                        <span key={peT?.flashAt} className={`px-0.5 rounded ${peT?.flashAt ? (peT.dir === "up" ? "flash-up" : "flash-down") : ""}`}>{fmt(peT?.ltp ?? r.pe.ltp)}</span>
                        {(r.pe.live || peT) && <span className="text-[8px] text-emerald-400 align-top">●</span>}
                        <div className={`text-[10px] ${r.pe.change >= 0 ? "up" : "down"}`}>{r.pe.changePct}%</div>
                      </td>
                      <td className={`mono text-[11px] ${peItm ? "bg-amber-500/5" : ""}`}>{r.pe.iv}</td>
                      <td className="mono text-[11px] text-sky-300">{r.pe.delta}</td>
                      {showGreeks && (
                        <>
                          <td className="mono text-[11px]">{r.pe.vega}</td>
                          <td className="mono text-[11px]">{r.pe.theta}</td>
                          <td className="mono text-[11px]">{r.pe.gamma}</td>
                        </>
                      )}
                      <td className={`mono text-[11px] ${peItm ? "bg-amber-500/5" : ""} ${r.pe.oiChange >= 0 ? "up" : "down"}`}>{fmtOi(Math.abs(r.pe.oiChange))}</td>
                      <td className={`mono relative ${peItm ? "bg-amber-500/5" : ""}`}>
                        <div className="absolute inset-y-1 left-0 bg-red-500/15 rounded-r" style={{ width: `${(r.pe.oi / maxOi) * 100}%` }} />
                        <span className="relative">{fmtOi(r.pe.oi)}</span>
                      </td>
                      <td>
                        <div className="flex gap-1 justify-center">
                          <button className="btn btn-xs btn-green" onClick={() => trade(r, "PE", "BUY")}>
                            B
                          </button>
                          <button className="btn btn-xs btn-red" onClick={() => trade(r, "PE", "SELL")}>
                            S
                          </button>
                          <button className="btn btn-xs" title="PE chart kholo" onClick={() => openChart(r, "PE")}>
                            📈
                          </button>
                          <button
                            className="btn btn-xs text-amber-300 hover:bg-amber-500/20"
                            title="Add PE Strike to Watchlist ⭐"
                            onClick={() => {
                              if (!data) return;
                              const res = addOptionToWatchlist({
                                underlying: data.underlying,
                                strike: r.strike,
                                otype: "PE",
                                expiry,
                                lotSize: data.lotSize,
                                token: r.pe.token,
                                tradingSymbol: r.pe.tradingSymbol,
                              });
                              toast(res.message, res.ok ? "success" : "info");
                            }}
                          >
                            ⭐
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">● = live broker premium (0-delay stream; IV &amp; Greeks implied from the live price; real expiries/strikes from the synced scrip master). Without a live feed: spot from Yahoo (~15 min delay) and Black-Scholes model premiums/OI. Shaded cells = ITM.</p>
        </>
      )}

      {draft && <SetupForm initial={draft} onClose={() => setDraft(null)} onSaved={() => setDraft(null)} />}
    </div>
  );
}

function Stat({ label, value, sub, cls = "" }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="panel px-3 py-2">
      <div className="text-[10px] text-slate-400 font-semibold uppercase">{label}</div>
      <div className={`mono text-base font-bold ${cls}`}>{value}</div>
      {sub && <div className={`text-[10px] ${cls || "text-slate-500"}`}>{sub}</div>}
    </div>
  );
}
