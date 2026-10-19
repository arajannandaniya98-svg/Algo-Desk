"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, fmt, fmtInt, fmtOi } from "@/components/utils";
import { toast } from "@/components/Toast";
import { useLiveTicks } from "@/components/useLiveTicks";
import { SetupForm, type SetupDraft } from "@/components/SetupForm";
import {
  getStoredWatchlist,
  saveWatchlist,
  addStockToWatchlist,
  addOptionToWatchlist,
  removeFromWatchlist,
  type WatchlistItem,
  type WatchlistKind,
} from "@/lib/watchlist";
import type { MomentumStock } from "@/app/api/momentum/route";
import { labelExpiries, type ExpiryInfo } from "@/lib/expiry-labels";

type FilterTab = "ALL" | "MOMENTUM" | "STOCKS" | "OPTIONS" | "INDICES" | "CRYPTO";

const MOMENTUM_CATS = [
  { id: "ALL", label: "🔥 Top Overall Momentum" },
  { id: "GAINERS", label: "🟢 Top Day Gainers" },
  { id: "BREAKOUTS", label: "🚀 Breakouts" },
  { id: "52W", label: "📈 Near 52-Week High" },
  { id: "FNO", label: "⚡ F&O Leaders" },
];

export default function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [activeTab, setActiveTab] = useState<FilterTab>("ALL");
  const [momentumList, setMomentumList] = useState<MomentumStock[]>([]);
  const [momentumCat, setMomentumCat] = useState("ALL");
  const [loadingMomentum, setLoadingMomentum] = useState(false);
  const [showAddOptionModal, setShowAddOptionModal] = useState(false);
  const [searchSymbol, setSearchSymbol] = useState("");
  const [draft, setDraft] = useState<SetupDraft | null>(null);

  // Sync watchlist from storage
  const reloadWatchlist = useCallback(() => {
    setItems(getStoredWatchlist());
  }, []);

  useEffect(() => {
    reloadWatchlist();
    const handleUpdate = () => reloadWatchlist();
    window.addEventListener("algodesk-watchlist-updated", handleUpdate);
    return () => window.removeEventListener("algodesk-watchlist-updated", handleUpdate);
  }, [reloadWatchlist]);

  // Load Top Momentum Indian Stocks
  const loadMomentum = useCallback(async (cat: string) => {
    setLoadingMomentum(true);
    try {
      const res = await api<{ topMomentum: MomentumStock[] }>(`/api/momentum?cat=${cat}`);
      setMomentumList(res.topMomentum || []);
    } catch {
      // quiet fallback
    } finally {
      setLoadingMomentum(false);
    }
  }, []);

  useEffect(() => {
    loadMomentum(momentumCat);
    const id = setInterval(() => loadMomentum(momentumCat), 30000);
    return () => clearInterval(id);
  }, [loadMomentum, momentumCat]);

  // Extract list of symbols for real-time live quotes
  const watchSymbols = useMemo(() => {
    const syms = new Set<string>();
    items.forEach((it) => {
      if (it.kind === "OPTION" && it.underlying) {
        syms.add(it.underlying);
      } else {
        syms.add(it.symbol);
      }
    });
    // Add top momentum symbols too
    momentumList.slice(0, 15).forEach((m) => syms.add(m.symbol));
    return Array.from(syms);
  }, [items, momentumList]);

  // Option keys for live options ticks
  const optionKeys = useMemo(() => {
    return items
      .filter((it) => it.kind === "OPTION" && it.brokerToken)
      .map((it) => (it.exchange === "DELTA" ? `delta:DELTA:${it.tradingSymbol || it.symbol}` : `dhan:NSE_FNO:${it.brokerToken}`));
  }, [items]);

  const { ticks } = useLiveTicks(watchSymbols, optionKeys);

  // Filter personal watchlist
  const filteredItems = useMemo(() => {
    if (activeTab === "ALL") return items;
    if (activeTab === "STOCKS") return items.filter((i) => i.kind === "STOCK");
    if (activeTab === "OPTIONS") return items.filter((i) => i.kind === "OPTION");
    if (activeTab === "INDICES") return items.filter((i) => i.kind === "INDEX");
    if (activeTab === "CRYPTO") return items.filter((i) => i.kind === "CRYPTO");
    return items;
  }, [items, activeTab]);

  const handleAddStock = (m: MomentumStock) => {
    const res = addStockToWatchlist({
      symbol: m.symbol,
      name: m.name,
      exchange: m.exchange,
      segment: m.segment,
      lotSize: m.lotSize,
    });
    toast(res.message, res.ok ? "success" : "info");
  };

  const handleAddAllMomentum = () => {
    let added = 0;
    momentumList.slice(0, 10).forEach((m) => {
      const res = addStockToWatchlist({
        symbol: m.symbol,
        name: m.name,
        exchange: m.exchange,
        segment: m.segment,
        lotSize: m.lotSize,
      });
      if (res.ok) added++;
    });
    toast(`Added ${added} Top Momentum Stocks to your Watchlist! ⭐`, "success");
  };

  const handleSearchAdd = async () => {
    const sym = searchSymbol.trim().toUpperCase();
    if (!sym) return;
    try {
      const res = await api<{ items: { symbol: string; name: string; exchange: string; segment: string; lotSize: number }[] }>(
        `/api/instruments?q=${encodeURIComponent(sym)}&limit=10`
      );
      const match = res.items.find((i) => i.symbol === sym) || res.items[0];
      if (match) {
        const r = addStockToWatchlist({
          symbol: match.symbol,
          name: match.name,
          exchange: match.exchange,
          segment: match.segment,
          lotSize: match.lotSize,
        });
        toast(r.message, r.ok ? "success" : "info");
        setSearchSymbol("");
      } else {
        toast(`Symbol ${sym} not found in master database`, "error");
      }
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const tradeItem = (it: WatchlistItem, side: "BUY" | "SELL") => {
    const isCrypto = it.exchange === "DELTA" || it.segment === "CRYPTO" || it.symbol.endsWith("USD");
    const tick = ticks[it.symbol] || (it.underlying ? ticks[it.underlying] : undefined);
    const price = tick?.ltp ?? 0;

    setDraft({
      name: `${it.symbol} ${side}`,
      symbol: it.tradingSymbol || it.symbol,
      underlying: it.underlying || (it.kind === "INDEX" || isCrypto ? it.symbol : ""),
      exchange: it.exchange || (isCrypto ? "DELTA" : "NSE"),
      segment: it.segment || (isCrypto ? "CRYPTO" : "EQ"),
      instrumentType: it.kind === "OPTION" ? it.otype || "CE" : it.kind === "INDEX" || isCrypto ? "FUT" : "EQ",
      strike: it.strike,
      expiry: it.expiry,
      side,
      quantity: isCrypto ? 1 : it.lotSize || 1,
      productType: it.kind === "STOCK" ? "MIS" : "NRML",
      orderType: "MARKET",
      entryPrice: price > 0 ? price : undefined,
      brokerToken: it.brokerToken || "",
      notes: `Watchlist Quick Trade · ${it.kind}`,
    });
  };

  const openChart = (it: WatchlistItem) => {
    if (it.kind === "OPTION" && it.underlying && it.strike && it.otype && it.expiry) {
      localStorage.setItem("algodesk.chartSymbol", it.symbol);
      localStorage.setItem(
        "algodesk.chartOption",
        JSON.stringify({
          underlying: it.underlying,
          strike: it.strike,
          otype: it.otype,
          expiry: it.expiry,
        })
      );
    } else {
      localStorage.setItem("algodesk.chartSymbol", it.symbol);
      localStorage.removeItem("algodesk.chartOption");
    }
    window.location.href = "/";
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span>⭐ Watchlist</span>
            <span className="badge bg-sky-500/20 text-sky-300 font-bold border border-sky-500/30">
              {items.length} Tracked
            </span>
          </h1>
          <p className="text-xs text-slate-400">
            India Top Momentum Stocks &amp; Live Option Chain Tracker · Real-time ticks &amp; 1-Click Execution
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Search and Add Any Stock */}
          <div className="flex items-center gap-1">
            <input
              type="text"
              className="input mono text-xs py-1 w-32"
              placeholder="Search symbol..."
              value={searchSymbol}
              onChange={(e) => setSearchSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleSearchAdd()}
            />
            <button className="btn btn-xs btn-primary font-bold" onClick={handleSearchAdd}>
              + Add
            </button>
          </div>

          {/* Add Option Chain on Demand */}
          <button
            className="btn btn-xs bg-purple-500/20 text-purple-300 border-purple-500/40 hover:bg-purple-500/30 font-bold flex items-center gap-1.5"
            onClick={() => setShowAddOptionModal(true)}
            title="Add Option Chain Contracts (Nifty, Sensex, Stocks, Crypto) to Watchlist"
          >
            <span>⛓ + Add Option Strike</span>
          </button>
        </div>
      </div>

      {/* 🇮🇳 TOP SECTION: India's Top Momentum Stocks Scanner */}
      <div className="panel p-3.5 space-y-3 bg-[#0d1424] border-sky-500/30">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1f2937] pb-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white flex items-center gap-1.5">
              <span>🇮🇳 India Top Momentum Stocks</span>
              <span className="badge bg-emerald-500/20 text-emerald-300 text-[10px]">Real-Time Scanner</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {MOMENTUM_CATS.map((c) => (
              <button
                key={c.id}
                className={`btn btn-xs py-0.5 px-2 ${
                  momentumCat === c.id ? "btn-primary font-bold shadow-sm" : "bg-[#111827] text-slate-400 hover:text-white"
                }`}
                onClick={() => setMomentumCat(c.id)}
              >
                {c.label}
              </button>
            ))}

            <button
              className="btn btn-xs btn-green font-bold ml-1"
              onClick={handleAddAllMomentum}
              title="Add Top 10 momentum stocks directly to your watchlist"
            >
              ⭐ + Add Top 10 to Watchlist
            </button>
          </div>
        </div>

        {/* Momentum Stocks Grid Cards */}
        {loadingMomentum && momentumList.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-500">Scanning Indian market momentum stocks…</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {momentumList.slice(0, 12).map((m) => {
              const inWatch = items.some((it) => it.symbol === m.symbol);
              const t = ticks[m.symbol];
              const ltp = t?.ltp ?? m.ltp;
              const chgPct = t?.changePct ?? m.changePct;
              return (
                <div
                  key={m.symbol}
                  className="rounded-lg border border-[#202e42] bg-[#0a101d] p-2 hover:border-sky-500/50 transition flex flex-col justify-between space-y-1.5"
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0">
                      <div className="font-bold mono text-xs text-white truncate flex items-center gap-1">
                        {m.symbol}
                        {m.isFno && <span className="text-[8.5px] px-1 rounded bg-purple-500/20 text-purple-300 font-bold">F&amp;O</span>}
                      </div>
                      <div className="text-[9.5px] text-slate-400 truncate">{m.name}</div>
                    </div>
                    <span
                      className={`badge text-[8px] font-black ${
                        m.tag === "52W_HIGH"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : m.tag === "TOP_GAINER"
                          ? "bg-green-500/20 text-green-300"
                          : "bg-sky-500/20 text-sky-300"
                      }`}
                    >
                      {m.tag.replace("_", " ")}
                    </span>
                  </div>

                  <div className="flex items-baseline justify-between">
                    <span className="mono text-xs font-black text-white">₹{fmt(ltp)}</span>
                    <span className={`mono text-[10px] font-bold ${chgPct >= 0 ? "up" : "down"}`}>
                      {chgPct >= 0 ? "+" : ""}
                      {fmt(chgPct)}%
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[9px] text-slate-400 pt-1 border-t border-[#182436]">
                    <span>Score: <b className="text-sky-300">{m.momentumScore}</b></span>
                    <div className="flex items-center gap-1">
                      {m.isFno && (
                        <Link
                          href={`/options?u=${m.symbol}`}
                          className="text-purple-300 hover:text-purple-200 font-bold"
                          title="Open Option Chain"
                        >
                          ⛓
                        </Link>
                      )}
                      <button
                        className={`text-[9px] px-1.5 py-0.5 rounded font-bold transition ${
                          inWatch ? "bg-slate-700 text-slate-400" : "bg-sky-500/20 hover:bg-sky-500/30 text-sky-300"
                        }`}
                        onClick={() => handleAddStock(m)}
                        disabled={inWatch}
                      >
                        {inWatch ? "✓ Tracked" : "+ Add"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* PERSONAL WATCHLIST SECTION */}
      <div className="panel overflow-hidden space-y-0">
        {/* Watchlist Filter Bar */}
        <div className="p-3 border-b border-[#1f2937] flex flex-wrap items-center justify-between gap-2 bg-[#0c121e]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-slate-400 uppercase font-bold mr-1">Filter:</span>
            {[
              { id: "ALL", label: `All (${items.length})` },
              { id: "STOCKS", label: `Stocks (${items.filter((i) => i.kind === "STOCK").length})` },
              { id: "OPTIONS", label: `Option Contracts (${items.filter((i) => i.kind === "OPTION").length})` },
              { id: "INDICES", label: `Indices (${items.filter((i) => i.kind === "INDEX").length})` },
              { id: "CRYPTO", label: `Crypto (${items.filter((i) => i.kind === "CRYPTO").length})` },
            ].map((t) => (
              <button
                key={t.id}
                className={`btn btn-xs py-0.5 px-2 ${
                  activeTab === t.id ? "btn-primary font-bold shadow-sm" : "bg-[#111827] text-slate-400 hover:text-white"
                }`}
                onClick={() => setActiveTab(t.id as FilterTab)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>● Real-Time Live Stream Active</span>
          </div>
        </div>

        {/* Watchlist Table */}
        <div className="overflow-x-auto">
          <table className="tbl w-full text-xs">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Instrument</th>
                <th>Segment</th>
                <th>Live Price</th>
                <th>24h Chg %</th>
                <th>Option / Strike Info</th>
                <th>Lot</th>
                <th className="text-center">Trade Setup</th>
                <th className="text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((it) => {
                const tick = ticks[it.symbol] || (it.underlying ? ticks[it.underlying] : undefined);
                const ltp = tick?.ltp ?? 0;
                const chg = tick?.change ?? 0;
                const chgPct = tick?.changePct ?? 0;
                const isCrypto = it.exchange === "DELTA" || it.segment === "CRYPTO" || it.symbol.endsWith("USD");
                const cur = isCrypto ? "$" : "₹";

                return (
                  <tr key={it.id} className="hover:bg-[#121c2e] transition">
                    <td>
                      <div className="font-bold mono text-sm text-white flex items-center gap-1.5">
                        <span>{it.symbol}</span>
                        {it.kind === "OPTION" && (
                          <span
                            className={`badge text-[9px] font-black ${
                              it.otype === "CE" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                            }`}
                          >
                            {it.otype}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate max-w-[180px]">{it.name}</div>
                    </td>

                    <td>
                      <span className="badge bg-slate-800 text-slate-300 border border-slate-700 font-semibold">
                        {it.exchange} · {it.segment}
                      </span>
                    </td>

                    <td>
                      <span
                        className={`badge font-bold text-[9px] ${
                          it.kind === "OPTION"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                            : it.kind === "CRYPTO"
                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                            : it.kind === "INDEX"
                            ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                            : "bg-slate-700/50 text-slate-300"
                        }`}
                      >
                        {it.kind}
                      </span>
                    </td>

                    {/* Live LTP */}
                    <td className="mono font-bold text-sm">
                      <span
                        key={tick?.flashAt}
                        className={`px-1 py-0.5 rounded transition ${
                          tick?.flashAt ? (tick.dir === "up" ? "flash-up" : "flash-down") : "text-white"
                        }`}
                      >
                        {cur}
                        {fmt(ltp)}
                      </span>
                    </td>

                    {/* Change % */}
                    <td className={`mono font-semibold ${chgPct >= 0 ? "up" : "down"}`}>
                      {chgPct >= 0 ? "+" : ""}
                      {fmt(chgPct)}%
                    </td>

                    {/* Option Specific Details or Underlying Quick Access */}
                    <td>
                      {it.kind === "OPTION" ? (
                        <div className="text-[10px] mono space-y-0.5">
                          <div>
                            Strike: <b className="text-white">{it.strike}</b> ({it.otype})
                          </div>
                          <div className="text-slate-400">
                            Exp: <b className="text-sky-300">{it.expiry}</b>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          {/* Option Chain Button for Stocks / Indices */}
                          <Link
                            href={`/options?u=${it.symbol}`}
                            className="btn btn-xs bg-purple-500/20 text-purple-300 border-purple-500/30 hover:bg-purple-500/30 font-bold"
                            title={`Open live Option Chain for ${it.symbol}`}
                          >
                            ⛓ Option Chain
                          </Link>
                        </div>
                      )}
                    </td>

                    <td className="mono text-slate-400">{it.lotSize}</td>

                    {/* Quick Trade BUY / SELL */}
                    <td>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          className="btn btn-xs btn-green px-2 py-0.5 font-bold"
                          onClick={() => tradeItem(it, "BUY")}
                          title={`BUY ${it.symbol}`}
                        >
                          BUY
                        </button>
                        <button
                          className="btn btn-xs btn-red px-2 py-0.5 font-bold"
                          onClick={() => tradeItem(it, "SELL")}
                          title={`SELL ${it.symbol}`}
                        >
                          SELL
                        </button>
                      </div>
                    </td>

                    {/* Chart / Delete Actions */}
                    <td>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          className="btn btn-xs bg-[#172338] text-sky-300 hover:text-white"
                          onClick={() => openChart(it)}
                          title="Open Chart on Dashboard"
                        >
                          📈 Chart
                        </button>
                        <button
                          className="btn btn-xs text-slate-500 hover:text-red-400"
                          onClick={() => removeFromWatchlist(it.id)}
                          title="Remove from Watchlist"
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-8 text-slate-500">
                    No items in this category. Add top momentum stocks from above or search any instrument!
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Option Strike Picker Modal */}
      {showAddOptionModal && (
        <AddOptionToWatchlistModal onClose={() => setShowAddOptionModal(false)} />
      )}

      {/* Setup Form Drawer */}
      {draft && <SetupForm initial={draft} onClose={() => setDraft(null)} onSaved={() => setDraft(null)} />}
    </div>
  );
}

// ----------------- Add Option Strike to Watchlist Modal -----------------
function AddOptionToWatchlistModal({ onClose }: { onClose: () => void }) {
  const [underlying, setUnderlying] = useState("NIFTY");
  const [expiry, setExpiry] = useState("");
  const [chainData, setChainData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const OPTIONS_UNDERLYINGS = [
    { sym: "NIFTY", name: "Nifty 50" },
    { sym: "BANKNIFTY", name: "Bank Nifty" },
    { sym: "SENSEX", name: "Sensex" },
    { sym: "FINNIFTY", name: "Fin Nifty" },
    { sym: "TRENT", name: "Trent Ltd" },
    { sym: "RELIANCE", name: "Reliance Ind" },
    { sym: "BEL", name: "Bharat Electronics" },
    { sym: "HAL", name: "Hindustan Aero" },
    { sym: "BTCUSD", name: "Bitcoin (Delta)" },
  ];

  const loadChain = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ underlying, strikes: "7" });
      if (expiry) p.set("expiry", expiry);
      const res = await api<any>(`/api/options-chain?${p.toString()}`);
      setChainData(res);
      if (!expiry || !res.expiries.includes(expiry)) {
        setExpiry(res.expiry);
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [underlying, expiry]);

  useEffect(() => {
    loadChain();
  }, [loadChain]);

  const expiries: ExpiryInfo[] = useMemo(() => {
    return labelExpiries(chainData?.expiries ?? []);
  }, [chainData]);

  const handleAddStrike = (strike: number, otype: "CE" | "PE", leg: any) => {
    if (!chainData) return;
    const res = addOptionToWatchlist({
      underlying,
      strike,
      otype,
      expiry: chainData.expiry,
      lotSize: chainData.lotSize,
      exchange: underlying.endsWith("USD") ? "DELTA" : underlying === "SENSEX" ? "BSE" : "NSE",
      token: leg.token,
      tradingSymbol: leg.tradingSymbol,
    });
    toast(res.message, res.ok ? "success" : "info");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="panel w-full max-w-3xl p-5 bg-[#0d1320] border-[#263244] max-h-[90vh] overflow-y-auto space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#1f2937] pb-3">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              ⛓ Add Option Strike to Watchlist
            </h2>
            <p className="text-xs text-slate-400">
              Pick any Strike (CE or PE) to track live tick-by-tick alongside your stocks in the watchlist.
            </p>
          </div>
          <button className="btn btn-xs" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 1. Pick Underlying */}
        <div className="space-y-1">
          <label className="label">Select Underlying Asset / Index:</label>
          <div className="flex flex-wrap gap-1.5">
            {OPTIONS_UNDERLYINGS.map((u) => (
              <button
                key={u.sym}
                className={`btn btn-xs ${underlying === u.sym ? "btn-primary font-bold shadow-sm" : "bg-[#111827] text-slate-300"}`}
                onClick={() => {
                  setUnderlying(u.sym);
                  setExpiry("");
                }}
              >
                {u.sym}
              </button>
            ))}
          </div>
        </div>

        {/* 2. Pick Expiry */}
        <div className="space-y-1">
          <label className="label">Expiry (This Week / Next Week / Monthly):</label>
          <div className="flex flex-wrap gap-1.5">
            {expiries.slice(0, 6).map((x) => (
              <button
                key={x.date}
                className={`btn btn-xs ${expiry === x.date ? "btn-primary font-bold shadow-sm" : "bg-[#111827] text-slate-300"}`}
                onClick={() => setExpiry(x.date)}
              >
                {x.label === "This Week" || x.label === "Today" ? "📅 " : ""}
                {x.label}
                {x.monthly && <span className="ml-1 badge bg-violet-500/20 text-violet-300 text-[8px]">M</span>}
                <span className="ml-1 text-[9px] opacity-75">{x.date.slice(5)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 3. Strikes Table with Add Buttons */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="label mb-0">Select Option Strike to Add:</label>
            {chainData && (
              <span className="text-[11px] text-slate-400 mono">
                Spot: <b className="text-sky-300">₹{fmt(chainData.spot?.ltp)}</b> · ATM: <b className="text-white">{chainData.atm}</b>
              </span>
            )}
          </div>

          <div className="max-h-60 overflow-y-auto rounded-lg border border-[#263244]">
            <table className="tbl w-full text-xs text-center">
              <thead className="sticky top-0 bg-[#111827]">
                <tr>
                  <th className="text-green-400">+ Watchlist</th>
                  <th>CE LTP</th>
                  <th>CE Δ</th>
                  <th className="bg-[#0b1220] text-white">STRIKE</th>
                  <th>PE Δ</th>
                  <th>PE LTP</th>
                  <th className="text-red-400">+ Watchlist</th>
                </tr>
              </thead>
              <tbody>
                {(chainData?.chain ?? []).map((r: any) => {
                  const isAtm = r.strike === chainData.atm;
                  return (
                    <tr key={r.strike} className={isAtm ? "bg-sky-500/15" : ""}>
                      {/* Add CE Button */}
                      <td>
                        <button
                          className="btn btn-xs btn-green py-0.5 px-2 font-bold"
                          onClick={() => handleAddStrike(r.strike, "CE", r.ce)}
                          title={`Add ${underlying} ${r.strike} CE to Watchlist`}
                        >
                          + CE ⭐
                        </button>
                      </td>
                      <td className="mono font-semibold text-emerald-300">{fmt(r.ce.ltp)}</td>
                      <td className="mono text-[10px] text-sky-300">{r.ce.delta}</td>

                      {/* Strike */}
                      <td className={`mono font-black ${isAtm ? "text-sky-300" : "text-white"} bg-[#0b1220]`}>
                        {r.strike} {isAtm && <span className="text-[8px] text-sky-400 block">ATM</span>}
                      </td>

                      <td className="mono text-[10px] text-sky-300">{r.pe.delta}</td>
                      <td className="mono font-semibold text-red-300">{fmt(r.pe.ltp)}</td>

                      {/* Add PE Button */}
                      <td>
                        <button
                          className="btn btn-xs btn-red py-0.5 px-2 font-bold"
                          onClick={() => handleAddStrike(r.strike, "PE", r.pe)}
                          title={`Add ${underlying} ${r.strike} PE to Watchlist`}
                        >
                          + PE ⭐
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-[#1f2937]">
          <Link
            href={`/options?u=${underlying}`}
            className="text-xs text-purple-400 hover:underline font-bold"
            onClick={onClose}
          >
            Open Full Interactive Option Chain Page ↗
          </Link>

          <button className="btn btn-xs" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
