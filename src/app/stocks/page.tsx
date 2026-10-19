"use client";

import { useCallback, useEffect, useState } from "react";
import type { Instrument, Setup } from "@/db/schema";
import type { Quote } from "@/lib/market";
import { api, fmt, fmtCr, fmtInt } from "@/components/utils";
import { SetupForm, type SetupDraft } from "@/components/SetupForm";
import { toast } from "@/components/Toast";
import { addStockToWatchlist } from "@/lib/watchlist";

type Row = Instrument & { quote: Quote };

const SEGMENTS = ["ALL", "EQ", "INDEX", "COMMODITY", "CURRENCY", "CRYPTO"];
const EXCHANGES = ["ALL", "NSE", "BSE", "MCX", "CDS", "DELTA"];

export default function StocksPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [sectors, setSectors] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ q: "", exchange: "ALL", segment: "ALL", sector: "ALL", fno: false, minPrice: "", maxPrice: "", minChange: "", maxChange: "", sort: "symbol", dir: "asc" });
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [custom, setCustom] = useState({ symbol: "", name: "", exchange: "NSE", segment: "EQ", sector: "Other", lotSize: 1, basePrice: "", isFno: false });

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v === "" || v === false || v === "ALL") return;
      p.set(k, v === true ? "1" : String(v));
    });
    try {
      const r = await api<{ items: Row[]; sectors: string[]; count: number }>(`/api/instruments?${p}`);
      setRows(r.items);
      setSectors(r.sectors);
      setCount(r.count);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const setF = (k: string, v: unknown) => setFilters((s) => ({ ...s, [k]: v }));
  const sortBy = (k: string) => setFilters((s) => ({ ...s, sort: k, dir: s.sort === k && s.dir === "asc" ? "desc" : "asc" }));
  const SortTh = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <th className="cursor-pointer select-none hover:text-slate-200" onClick={() => sortBy(k)}>
      {children} {filters.sort === k ? (filters.dir === "asc" ? "↑" : "↓") : ""}
    </th>
  );

  const trade = (r: Row, side: "BUY" | "SELL") => {
    if (r.segment === "CRYPTO") {
      setDraft({
        name: `${r.symbol} ${side} PERP`,
        symbol: r.symbol,
        underlying: r.symbol,
        exchange: "DELTA",
        segment: "CRYPTO",
        instrumentType: "FUT",
        side,
        quantity: 1,
        productType: "NRML",
        entryPrice: r.quote.ltp,
        notes: "Delta Exchange perpetual — 1 contract (BTC 0.001 / ETH 0.01) · price in USD",
      });
      return;
    }
    const instrumentType = r.segment === "INDEX" ? "FUT" : r.segment === "COMMODITY" || r.segment === "CURRENCY" ? "FUT" : "EQ";
    setDraft({
      name: `${r.symbol} ${side} ${instrumentType}`,
      symbol: r.symbol,
      underlying: instrumentType === "EQ" ? "" : r.symbol,
      exchange: r.exchange,
      segment: r.segment === "INDEX" ? "FUT" : r.segment,
      instrumentType,
      side,
      quantity: r.lotSize,
      productType: instrumentType === "EQ" ? "MIS" : "NRML",
      entryPrice: r.quote.ltp,
    });
  };

  const addCustom = async () => {
    try {
      await api("/api/instruments", { method: "POST", body: JSON.stringify(custom) });
      toast(`${custom.symbol.toUpperCase()} added`, "success");
      setShowAdd(false);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const presets = [
    { label: "Top Gainers", f: { sort: "changePct", dir: "desc", minChange: "0" } },
    { label: "Top Losers", f: { sort: "changePct", dir: "asc", maxChange: "0" } },
    { label: "Most Active", f: { sort: "volume", dir: "desc" } },
    { label: "Large Cap", f: { sort: "marketCap", dir: "desc", segment: "EQ" } },
    { label: "F&O Only", f: { fno: true, segment: "EQ" } },
    { label: "Under ₹100", f: { maxPrice: "100", segment: "EQ", sort: "ltp", dir: "asc" } },
    { label: "₿ Crypto 24×7", f: { segment: "CRYPTO", sort: "changePct", dir: "desc" } },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">Stock Finder</h1>
          <p className="text-xs text-slate-400">All segments · {count} instruments · Yahoo Finance quote feed (fallback simulator for unsupported symbols)</p>
        </div>
        <button className="btn" onClick={() => setShowAdd(!showAdd)}>
          + Add Symbol
        </button>
      </div>

      {showAdd && (
        <div className="panel p-3 grid grid-cols-2 md:grid-cols-8 gap-2 items-end">
          <input className="input mono" placeholder="SYMBOL" value={custom.symbol} onChange={(e) => setCustom({ ...custom, symbol: e.target.value })} />
          <input className="input col-span-2" placeholder="Company name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          <select className="input" value={custom.exchange} onChange={(e) => setCustom({ ...custom, exchange: e.target.value })}>
            {EXCHANGES.slice(1).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <select className="input" value={custom.segment} onChange={(e) => setCustom({ ...custom, segment: e.target.value })}>
            {SEGMENTS.slice(1).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <input className="input mono" type="number" placeholder="Price" value={custom.basePrice} onChange={(e) => setCustom({ ...custom, basePrice: e.target.value })} />
          <input className="input mono" type="number" placeholder="Lot" value={custom.lotSize} onChange={(e) => setCustom({ ...custom, lotSize: Number(e.target.value) })} />
          <button className="btn btn-primary" onClick={addCustom}>
            Save
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="panel p-3">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
          <input className="input col-span-2" placeholder="Search symbol or name…" value={filters.q} onChange={(e) => setF("q", e.target.value)} />
          <select className="input" value={filters.exchange} onChange={(e) => setF("exchange", e.target.value)}>
            {EXCHANGES.map((x) => (
              <option key={x} value={x}>
                {x === "ALL" ? "All Exchanges" : x}
              </option>
            ))}
          </select>
          <select className="input" value={filters.segment} onChange={(e) => setF("segment", e.target.value)}>
            {SEGMENTS.map((x) => (
              <option key={x} value={x}>
                {x === "ALL" ? "All Segments" : x}
              </option>
            ))}
          </select>
          <select className="input" value={filters.sector} onChange={(e) => setF("sector", e.target.value)}>
            <option value="ALL">All Sectors</option>
            {sectors.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <input className="input mono" type="number" placeholder="Min ₹" value={filters.minPrice} onChange={(e) => setF("minPrice", e.target.value)} />
          <input className="input mono" type="number" placeholder="Max ₹" value={filters.maxPrice} onChange={(e) => setF("maxPrice", e.target.value)} />
          <label className="flex items-center gap-2 text-xs px-2">
            <input type="checkbox" checked={filters.fno} onChange={(e) => setF("fno", e.target.checked)} /> F&O only
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {presets.map((p) => (
            <button key={p.label} className="btn btn-xs" onClick={() => setFilters((s) => ({ ...s, q: "", exchange: "ALL", segment: "ALL", sector: "ALL", fno: false, minPrice: "", maxPrice: "", minChange: "", maxChange: "", sort: "symbol", dir: "asc", ...p.f }))}>
              {p.label}
            </button>
          ))}
          <button className="btn btn-xs" onClick={() => setFilters({ q: "", exchange: "ALL", segment: "ALL", sector: "ALL", fno: false, minPrice: "", maxPrice: "", minChange: "", maxChange: "", sort: "symbol", dir: "asc" })}>
            Reset
          </button>
          <span className="text-[11px] text-slate-500 ml-auto self-center">{loading ? "Refreshing…" : `${rows.length} shown`}</span>
        </div>
      </div>

      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <SortTh k="symbol">Symbol</SortTh>
              <th>Exch/Seg</th>
              <th>Sector</th>
              <SortTh k="ltp">LTP</SortTh>
              <SortTh k="changePct">Chg %</SortTh>
              <th>O / H / L</th>
              <SortTh k="volume">Volume</SortTh>
              <SortTh k="marketCap">Mkt Cap</SortTh>
              <SortTh k="pe">P/E</SortTh>
              <th>Lot</th>
              <th>Trade</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol}>
                <td>
                  <div className="font-bold mono">{r.symbol}</div>
                  <div className="text-[11px] text-slate-400 max-w-[180px] truncate">{r.name}</div>
                </td>
                <td className="text-[11px]">
                  <span className="badge bg-slate-700/50 text-slate-300">{r.exchange}</span> <span className="badge bg-slate-700/50 text-slate-300">{r.segment}</span>
                  {r.isFno && <span className="badge bg-violet-500/20 text-violet-300 ml-1">F&O</span>}
                </td>
                <td className="text-xs text-slate-300">{r.sector}</td>
                <td className="mono font-semibold">{fmt(r.quote.ltp)}</td>
                <td className={`mono font-semibold ${r.quote.changePct >= 0 ? "up" : "down"}`}>
                  {r.quote.changePct >= 0 ? "+" : ""}
                  {r.quote.changePct}%
                </td>
                <td className="mono text-[11px] text-slate-400">
                  {fmt(r.quote.open)} / <span className="up">{fmt(r.quote.high)}</span> / <span className="down">{fmt(r.quote.low)}</span>
                </td>
                <td className="mono text-xs">{fmtInt(r.quote.volume)}</td>
                <td className="mono text-xs">{fmtCr(r.marketCap)}</td>
                <td className="mono text-xs">{r.pe ? r.pe : "—"}</td>
                <td className="mono text-xs">{r.lotSize}</td>
                <td>
                  <div className="flex gap-1">
                    <button className="btn btn-xs btn-green" onClick={() => trade(r, "BUY")}>
                      B
                    </button>
                    <button className="btn btn-xs btn-red" onClick={() => trade(r, "SELL")}>
                      S
                    </button>
                    <button
                      className="btn btn-xs"
                      title="Chart kholo (dashboard)"
                      onClick={() => {
                        localStorage.setItem("algodesk.chartSymbol", r.symbol);
                        localStorage.removeItem("algodesk.chartOption");
                        window.location.href = "/";
                      }}
                    >
                      📈
                    </button>
                    {r.isFno && (
                      <a className="btn btn-xs" href={`/options?u=${r.symbol}`}>
                        OC
                      </a>
                    )}
                    <button
                      className="btn btn-xs text-amber-300 hover:bg-amber-500/20"
                      title="Add to Watchlist ⭐"
                      onClick={() => {
                        const res = addStockToWatchlist({
                          symbol: r.symbol,
                          name: r.name,
                          exchange: r.exchange,
                          segment: r.segment,
                          lotSize: r.lotSize,
                        });
                        toast(res.message, res.ok ? "success" : "info");
                      }}
                    >
                      ⭐
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="text-center text-slate-500 py-8">
                  No instruments match these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {draft && <SetupForm initial={draft} onClose={() => setDraft(null)} onSaved={(_s: Setup) => setDraft(null)} />}
    </div>
  );
}
