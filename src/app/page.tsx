"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Order, Setup } from "@/db/schema";
import type { Quote } from "@/lib/market";
import { api, fmt, statusColor, providerName } from "@/components/utils";
import { toast } from "@/components/Toast";
import { CapitalPanel } from "@/components/CapitalPanel";
import { ExcelSync } from "@/components/ExcelSync";
import { useLiveTicks } from "@/components/useLiveTicks";
import { TradingChart } from "@/components/TradingChart";
import { MarketSnapshot } from "@/components/MarketSnapshot";
import { MarketNewsTicker } from "@/components/MarketNewsTicker";

const TICKER = [
  // Indices
  "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "INDIAVIX",
  // Commodities & Forex
  "GOLD", "SILVER", "CRUDEOIL", "NATURALGAS", "COPPER", "USDINR", "EURINR", "GBPINR", "JPYINR",
  // Crypto 24×7
  "BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "BNBUSD"
];

const INDEX_GROUP = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "INDIAVIX"];
const COMMODITY_GROUP = ["GOLD", "SILVER", "CRUDEOIL", "NATURALGAS", "COPPER", "USDINR", "EURINR", "GBPINR", "JPYINR"];
const CRYPTO_GROUP = ["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "BNBUSD"];

// Segment bar should stay like the earlier simple setup (your original preference)
const SEGMENT_TABS = [
  { id: "ALL", label: "All Segments" },
  { id: "INDEX", label: "Indices" },
  { id: "COMMODITY", label: "Commodities & Forex" },
  { id: "CRYPTO", label: "Crypto 24×7" },
] as const;

type Dash = {
  stats: { total: number; active: number; entered: number; exited: number; realized: number; unrealized: number; todayPnl: number; brokers: number; liveBrokers: number; wins: number; losses: number };
  positions: (Setup & { ltp: number; unrealized: number })[];
  watching: Setup[];
  recentOrders: Order[];
  indices: Record<string, Quote>;
};

export default function Dashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [activeSegment, setActiveSegment] = useState<string>("ALL");

  const load = useCallback(() => api<Dash>("/api/dashboard").then(setD).catch(() => {}), []);
  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    window.addEventListener("engine-tick", load);
    return () => {
      clearInterval(id);
      window.removeEventListener("engine-tick", load);
    };
  }, [load]);

  const act = async (id: number, action: string) => {
    try {
      const r = await api<{ ok: boolean; message: string }>(`/api/setups/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      toast(r.message, r.ok ? "success" : "error");
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const openChartAndScroll = (symbol: string) => {
    localStorage.setItem("algodesk.chartSymbol", symbol);
    localStorage.removeItem("algodesk.chartOption");
    window.dispatchEvent(new CustomEvent("algodesk-open-chart", { detail: { symbol } }));
    const chartEl = document.getElementById("trading-chart-container");
    if (chartEl) {
      chartEl.scrollIntoView({ behavior: "smooth" });
    }
  };

  const { ticks } = useLiveTicks(TICKER);
  if (!d) return <div className="text-slate-400 text-sm">Loading terminal…</div>;
  const s = d.stats;
  const pnlCls = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");

  // Filter quotes by segment group (for summary counts only)
  const allQuotes = Object.values(d.indices);
  const filteredQuotes = allQuotes.filter((q) => {
    if (activeSegment === "ALL") return true;
    if (activeSegment === "INDEX") return INDEX_GROUP.includes(q.symbol);
    if (activeSegment === "COMMODITY") return COMMODITY_GROUP.includes(q.symbol);
    if (activeSegment === "CRYPTO") return CRYPTO_GROUP.includes(q.symbol);
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Live Scrolling Market News Ticker (Gujarati / Hindi / English) */}
      <MarketNewsTicker onSelectSymbol={openChartAndScroll} />

      {/* Segment Selector */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-slate-400 uppercase font-bold mr-1">Market Segments:</span>
            {SEGMENT_TABS.map((tab) => (
              <button
                key={tab.id}
                className={`btn btn-xs py-0.5 px-2 ${
                  activeSegment === tab.id
                    ? "btn-primary font-bold shadow-sm"
                    : "bg-[#111827] text-slate-400 hover:text-white border-[#263244]"
                }`}
                onClick={() => setActiveSegment(tab.id)}
                title={
                  tab.id === "INDEX"
                    ? INDEX_GROUP.join(", ")
                    : tab.id === "COMMODITY"
                    ? COMMODITY_GROUP.join(", ")
                    : tab.id === "CRYPTO"
                    ? CRYPTO_GROUP.join(", ")
                    : "All tracked segments"
                }
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500 hidden sm:inline">
              {activeSegment === "INDEX" && `${INDEX_GROUP.length} index symbols`}
              {activeSegment === "COMMODITY" && `${COMMODITY_GROUP.length} commodities / forex`}
              {activeSegment === "CRYPTO" && `${CRYPTO_GROUP.length} crypto symbols (24×7)`}
              {activeSegment === "ALL" && `${filteredQuotes.length} live tracked instruments`}
            </span>
            <Link
              href="/watchlist"
              className="btn btn-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 font-bold flex items-center gap-1"
            >
              ⭐ Watchlist ❯
            </Link>
          </div>
        </div>

        {/* Quick ticker cards under segments (restored as requested) */}
        <div className="flex gap-2 overflow-x-auto pb-1.5 pt-0.5">
          {filteredQuotes.map((q) => {
            const t = ticks[q.symbol];
            const ltp = t?.ltp ?? q.ltp;
            const ch = t?.change ?? q.change;
            const chp = t?.changePct ?? q.changePct;
            const src = t ? (t.simulated ? "DEMO" : "LIVE") : q.source === "live" ? "LIVE" : q.source === "yahoo" ? "YF" : "SIM";
            const isCrypto = q.symbol.endsWith("USD");
            const cur = isCrypto ? "$" : "₹";
            return (
              <div
                key={q.symbol}
                className="panel px-3 py-2 min-w-[155px] shrink-0 cursor-pointer hover:border-sky-500/60 hover:bg-[#121c2e] transition group"
                onClick={() => openChartAndScroll(q.symbol)}
                title={`Click to open ${q.symbol} Chart`}
              >
                <div className="text-[11px] text-slate-400 font-semibold flex items-center justify-between gap-1">
                  <span className="group-hover:text-sky-300 font-bold transition flex items-center gap-1">
                    {q.symbol}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className={`badge ${src === "LIVE" ? "bg-emerald-500/20 text-emerald-300" : src === "DEMO" ? "bg-amber-500/20 text-amber-300" : "bg-slate-600/30 text-slate-400"}`}>
                      {src}
                    </span>
                    <Link
                      href={`/options?u=${q.symbol}`}
                      className="text-[9.5px] px-1 py-0.5 rounded bg-purple-500/20 hover:bg-purple-500/40 text-purple-300 font-bold border border-purple-500/30 transition"
                      onClick={(e) => e.stopPropagation()}
                      title={`Open live Option Chain for ${q.symbol}`}
                    >
                      ⛓ OC
                    </Link>
                  </div>
                </div>
                <div className="mono text-sm font-bold mt-0.5">
                  <span key={t?.flashAt} className={t?.flashAt ? (t.dir === "up" ? "flash-up" : "flash-down") : "text-white"}>
                    {cur}{fmt(ltp)}
                  </span>
                </div>
                <div className={`mono text-[11px] ${pnlCls(ch)}`}>
                  {ch >= 0 ? "▲ +" : "▼ "}{fmt(ch)} ({chp}%)
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Trading chart + indicator signal */}
      <div id="trading-chart-container">
        <TradingChart />
      </div>

      {/* Detailed market snapshot */}
      <MarketSnapshot />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Stat label="Today P&L" value={`₹${fmt(s.todayPnl)}`} cls={pnlCls(s.todayPnl)} />
        <Stat label="Unrealized" value={`₹${fmt(s.unrealized)}`} cls={pnlCls(s.unrealized)} />
        <Stat label="Realized (all)" value={`₹${fmt(s.realized)}`} cls={pnlCls(s.realized)} />
        <Stat label="Open Positions" value={String(s.entered)} />
        <Stat label="Armed Setups" value={String(s.active)} />
        <Stat label="Win / Loss" value={`${s.wins} / ${s.losses}`} sub={s.wins + s.losses ? `${Math.round((s.wins / (s.wins + s.losses)) * 100)}% win` : ""} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Positions */}
        <div className="panel p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">Open Positions</h2>
            <Link href="/setups" className="text-xs text-sky-400 hover:underline">
              Manage setups →
            </Link>
          </div>
          {d.positions.length === 0 ? (
            <Empty text="No open positions. Create a setup from Stock Finder or Options Chain and click ENTER." />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Setup</th>
                    <th>Side</th>
                    <th>Qty</th>
                    <th>Entry</th>
                    <th>LTP</th>
                    <th>SL / Tgt</th>
                    <th>P&L</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {d.positions.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div className="font-semibold">{p.name}</div>
                        <div className="text-[11px] text-slate-400 mono">
                          {p.symbol} {p.instrumentType !== "EQ" && `${p.strike ?? ""} ${p.instrumentType}`}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${p.side === "BUY" ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>{p.side}</span>
                      </td>
                      <td className="mono">{p.quantity}</td>
                      <td className="mono">{fmt(p.entryFilledPrice)}</td>
                      <td className="mono">{fmt(p.ltp)}</td>
                      <td className="mono text-[11px]">
                        <span className="down">{fmt(p.stopLoss)}</span> / <span className="up">{fmt(p.target)}</span>
                      </td>
                      <td className={`mono font-bold ${pnlCls(p.unrealized)}`}>₹{fmt(p.unrealized)}</td>
                      <td>
                        <button className="btn btn-xs btn-red" onClick={() => act(p.id, "exit")}>
                          EXIT
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {d.watching.length > 0 && (
            <>
              <h3 className="font-bold mt-5 mb-2 text-sm">Armed / Watching</h3>
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Setup</th>
                      <th>Trigger</th>
                      <th>Entry</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.watching.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <div className="font-semibold">{w.name}</div>
                          <div className="text-[11px] text-slate-400 mono">{w.symbol}</div>
                        </td>
                        <td className="text-xs">{w.entryTrigger}</td>
                        <td className="mono">{fmt(w.entryPrice)}</td>
                        <td>{w.side}</td>
                        <td className="mono">{w.quantity}</td>
                        <td>
                          <button className="btn btn-xs btn-green" onClick={() => act(w.id, "enter")}>
                            ENTER
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Capital + Excel + recent orders */}
        <div className="space-y-4">
          <CapitalPanel />
          <ExcelSync />
          <div className="panel p-4">
            <h2 className="font-bold mb-3">Quick Actions</h2>
            <div className="grid grid-cols-2 gap-2">
              <Link href="/watchlist" className="btn border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 font-bold col-span-2 flex items-center justify-center gap-1.5">
                <span>⭐ Watchlist (Top Momentum &amp; Options)</span>
              </Link>
              <Link href="/stocks" className="btn">
                ⌕ Stock Finder
              </Link>
              <Link href="/options" className="btn">
                ⛓ Options Chain
              </Link>
              <Link href="/setups?new=1" className="btn btn-primary">
                + New Setup
              </Link>
              <Link href="/brokers" className="btn">
                ⚡ Brokers ({s.brokers})
              </Link>
            </div>
            <div className="mt-3 text-[11px] text-slate-500">
              {s.liveBrokers > 0 ? `${s.liveBrokers} broker(s) in LIVE mode` : "All brokers in paper mode — safe to test"}
            </div>
          </div>
          <div className="panel p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold">Recent Orders</h2>
              <Link href="/orders" className="text-xs text-sky-400 hover:underline">
                All →
              </Link>
            </div>
            {d.recentOrders.length === 0 ? (
              <Empty text="No orders yet" />
            ) : (
              <div className="space-y-2">
                {d.recentOrders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between text-xs border-b border-[#16202e] pb-2">
                    <div>
                      <span className={`font-bold ${o.side === "BUY" ? "up" : "down"}`}>{o.side}</span> <span className="mono">{o.symbol}</span> × {o.quantity}
                      <div className="text-[10px] text-slate-500">
                        {providerName[o.provider]} · {o.action} · {new Date(o.createdAt).toLocaleTimeString("en-IN")}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="mono">{fmt(o.filledPrice ?? o.price)}</div>
                      <span className={`badge ${statusColor[o.status]}`}>{o.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, cls = "", sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[11px] text-slate-400 font-semibold uppercase tracking-wide">{label}</div>
      <div className={`mono text-xl font-bold mt-0.5 ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="text-xs text-slate-500 border border-dashed border-[#263244] rounded-lg p-4 text-center">{text}</div>;
}
