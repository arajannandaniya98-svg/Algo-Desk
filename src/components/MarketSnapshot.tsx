"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, fmt, fmtCr, fmtInt, fmtOi } from "./utils";
import { toast } from "./Toast";
import { useLiveTicks } from "./useLiveTicks";

type Snap = {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  sector: string;
  lotSize: number;
  isFno: boolean;
  currency: string;
  quote: { ltp: number; open: number; high: number; low: number; prevClose: number; change: number; changePct: number; volume: number; oi?: number; source?: string; provider?: string; delayedMinutes?: number };
  ranges: { dayPct: number | null; high52: number; low52: number; yearPct: number | null; fromHigh52: number | null; fromLow52: number | null };
  fundamentals: { marketCap: number; pe: number };
  signal: { signal: string; score: number; strength: string; trend: string; buy: number; sell: number; hold: number; levels: { atr: number; stopLoss: number; target: number; support: number; resistance: number; riskReward: number }; candleSource?: string } | null;
  expiries: { date: string; label: string; monthly: boolean; dow: string; daysLeft: number }[];
  options: { expiry: string; atm: number; pcr: number | null; maxPain: number | null; atmIv: number | null; straddle: number | null; ceOi: number; peOi: number; source: string } | null;
  asOf: number;
};

const QUICK = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "RELIANCE", "BTCUSD"];
const SIG_CLS: Record<string, string> = { BUY: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", SELL: "bg-red-500/20 text-red-300 border-red-500/40", HOLD: "bg-slate-600/30 text-slate-300 border-slate-500/40" };

function Bar({ pct, lo, hi, cur }: { pct: number | null; lo: string; hi: string; cur: string }) {
  return (
    <div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden relative">
        {pct != null && <div className="absolute top-[-2px] h-2.5 w-2.5 rounded-full bg-sky-400 border border-slate-900" style={{ left: `calc(${Math.min(Math.max(pct, 0), 100)}% - 5px)` }} />}
        <div className="h-full bg-gradient-to-r from-red-500/50 via-amber-500/40 to-emerald-500/50" />
      </div>
      <div className="flex justify-between text-[9px] text-slate-500 mt-0.5 mono">
        <span>{lo}</span>
        <span className="text-slate-300">{cur}</span>
        <span>{hi}</span>
      </div>
    </div>
  );
}

export function MarketSnapshot() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [d, setD] = useState<Snap | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("algodesk.snapSymbol");
    if (saved && /^[A-Z0-9&_.-]{1,32}$/.test(saved)) setSymbol(saved);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setD(await api<Snap>(`/api/snapshot?symbol=${encodeURIComponent(symbol)}`));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [symbol]);
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const { ticks } = useLiveTicks([symbol]);
  const t = ticks[symbol];
  const ltp = t?.ltp ?? d?.quote.ltp ?? 0;
  const chg = t?.change ?? d?.quote.change ?? 0;
  const chgPct = t?.changePct ?? d?.quote.changePct ?? 0;
  const cur = d?.currency === "USD" ? "$" : "₹";

  const pick = (s: string) => {
    setSymbol(s);
    localStorage.setItem("algodesk.snapSymbol", s);
  };
  const doSearch = async () => {
    const s = search.trim().toUpperCase();
    if (!s) return;
    try {
      const r = await api<{ items: { symbol: string }[] }>(`/api/instruments?q=${encodeURIComponent(s)}&limit=20`);
      if (!r.items.some((i) => i.symbol === s)) return toast(`${s} not found — add it in Stock Finder first`, "error");
      pick(s);
      setSearch("");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const sig = d?.signal ?? null;
  const thisWeek = d?.expiries.find((e) => e.label === "This Week" || e.label === "Today");
  const nextWeek = d?.expiries.find((e) => e.label === "Next Week");
  const monthly = d?.expiries.find((e) => e.monthly);

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-bold">Market Snapshot</h2>
        <span className="text-[10px] text-slate-500">{loading ? "Loading…" : d ? `${d.name} · ${d.exchange} · ${d.sector}` : ""}</span>
        <div className="ml-auto flex gap-1">
          <input className="input mono w-28" placeholder="Symbol…" value={search} onChange={(e) => setSearch(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && doSearch()} />
          <button className="btn btn-xs" onClick={doSearch}>
            Go
          </button>
        </div>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {QUICK.map((s) => (
          <button key={s} className={`btn btn-xs shrink-0 ${symbol === s ? "btn-primary" : ""}`} onClick={() => pick(s)}>
            {s}
          </button>
        ))}
      </div>

      {d && (
        <>
          {/* price row */}
          <div className="flex flex-wrap items-center gap-3">
            <span key={t?.flashAt} className={`mono text-2xl font-black px-1 rounded ${t?.flashAt ? (t.dir === "up" ? "flash-up" : "flash-down") : ""}`}>
              {cur}
              {fmt(ltp)}
            </span>
            <span className={`mono text-sm font-bold ${chg >= 0 ? "up" : "down"}`}>
              {chg >= 0 ? "▲ +" : "▼ "}
              {fmt(chg)} ({chgPct}%)
            </span>
            {sig && <span className={`rounded-full border px-2.5 py-0.5 text-xs font-black ${SIG_CLS[sig.signal]}`}>{sig.signal} {sig.score > 0 ? `+${sig.score}` : sig.score}</span>}
            <span className="text-[10px] text-slate-500">
              {d.quote.source === "live" ? `● LIVE ${d.quote.provider ?? ""}` : d.quote.source === "yahoo" ? `Yahoo ~${d.quote.delayedMinutes ?? 15}m delay` : "simulated"}
            </span>
          </div>

          {/* OHLC + ranges */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center">
            <Cell k="Open" v={fmt(d.quote.open)} />
            <Cell k="High" v={fmt(d.quote.high)} cls="up" />
            <Cell k="Low" v={fmt(d.quote.low)} cls="down" />
            <Cell k="Prev Close" v={fmt(d.quote.prevClose)} />
            <Cell k="Volume" v={d.quote.volume ? fmtInt(d.quote.volume) : "—"} />
            <Cell k={d.segment === "EQ" ? "Mkt Cap" : "Lot Size"} v={d.segment === "EQ" ? fmtCr(d.fundamentals.marketCap) : String(d.lotSize)} />
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Day Range</div>
              <Bar pct={d.ranges.dayPct} lo={fmt(d.quote.low)} hi={fmt(d.quote.high)} cur={`${d.ranges.dayPct ?? "—"}%`} />
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase font-semibold mb-1">
                52-Week Range <span className="normal-case">({d.ranges.fromHigh52 != null ? `high thi ${d.ranges.fromHigh52}%` : "—"})</span>
              </div>
              <Bar pct={d.ranges.yearPct} lo={fmt(d.ranges.low52)} hi={fmt(d.ranges.high52)} cur={`${d.ranges.yearPct ?? "—"}%`} />
            </div>
          </div>

          {/* signal levels */}
          {sig && (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center">
              <Cell k="Trend" v={sig.trend === "UP" ? "▲ Up" : sig.trend === "DOWN" ? "▼ Down" : "↔ Range"} cls={sig.trend === "UP" ? "up" : sig.trend === "DOWN" ? "down" : ""} />
              <Cell k="Support" v={fmt(sig.levels.support)} />
              <Cell k="Resistance" v={fmt(sig.levels.resistance)} />
              <Cell k="Stop Loss" v={fmt(sig.levels.stopLoss)} cls="down" />
              <Cell k="Target" v={fmt(sig.levels.target)} cls="up" />
              <Cell k="ATR / R:R" v={`${fmt(sig.levels.atr)} · 1:${sig.levels.riskReward}`} />
            </div>
          )}

          {/* expiries */}
          {d.isFno && d.expiries.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Expiries</div>
              <div className="flex flex-wrap gap-1.5">
                {thisWeek && (
                  <Link href={`/options?u=${d.symbol}`} className="btn btn-xs">
                    📅 This Week · {thisWeek.date.slice(5)} {thisWeek.dow} ({thisWeek.daysLeft}d)
                  </Link>
                )}
                {nextWeek && (
                  <Link href={`/options?u=${d.symbol}`} className="btn btn-xs">
                    Next Week · {nextWeek.date.slice(5)} {nextWeek.dow}
                  </Link>
                )}
                {monthly && (
                  <Link href={`/options?u=${d.symbol}`} className="btn btn-xs">
                    Monthly · {monthly.date.slice(5)} {monthly.dow}
                  </Link>
                )}
                <span className="text-[10px] text-slate-500 self-center">{d.expiries.length} expiries →</span>
              </div>
            </div>
          )}

          {/* option metrics */}
          {d.options && (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center">
              <Cell k="ATM" v={String(d.options.atm)} />
              <Cell k="PCR (OI)" v={d.options.pcr != null ? String(d.options.pcr) : "—"} cls={d.options.pcr != null ? (d.options.pcr > 1.2 ? "up" : d.options.pcr < 0.8 ? "down" : "") : ""} />
              <Cell k="Max Pain" v={d.options.maxPain != null ? String(d.options.maxPain) : "—"} />
              <Cell k="ATM IV" v={d.options.atmIv != null ? `${d.options.atmIv}%` : "—"} />
              <Cell k="Straddle" v={d.options.straddle != null ? fmt(d.options.straddle) : "—"} />
              <Cell k="CE/PE OI" v={`${fmtOi(d.options.ceOi)} / ${fmtOi(d.options.peOi)}`} />
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Link href={`/options?u=${d.symbol}`} className="btn btn-xs">
              ⛓ Option Chain
            </Link>
            <Link href="/signals" className="btn btn-xs">
              ◎ Signals
            </Link>
            <span className="ml-auto text-[9px] text-slate-600">
              {d.options ? `Options: ${d.options.source === "live" ? "live exchange data" : "model estimate"} · ${d.options.expiry}` : ""} · {new Date(d.asOf).toLocaleTimeString("en-IN", { hour12: false })}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Cell({ k, v, cls = "" }: { k: string; v: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-[#0b1220] border border-[#263244] py-1.5 px-1">
      <div className="text-[9px] text-slate-500 uppercase">{k}</div>
      <div className={`mono text-xs font-bold truncate ${cls}`}>{v}</div>
    </div>
  );
}
