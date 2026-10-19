"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmt, fmtInt, fmtOi } from "@/components/utils";
import { toast } from "@/components/Toast";
import { useLiveTicks } from "@/components/useLiveTicks";
import type { FeedStatus } from "@/lib/feed/types";

type FeedInfo = {
  status: FeedStatus;
  tokens: Record<string, number>;
  settings: { feedBrokerId: number | null; feedAutoStart: boolean; tokenSync: Record<string, { at: string; rows: number }> };
  brokers: { id: number; label: string; provider: string; mode: string; hasToken: boolean }[];
};
const DEFAULT_WATCH = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "INDIAVIX", "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "BTCUSD", "ETHUSD"];
const STORAGE = "algodesk.watchlist";

const exTime = (ts?: number) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.toLocaleTimeString("en-IN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

export default function LiveFeedPage() {
  const [info, setInfo] = useState<FeedInfo | null>(null);
  const [role, setRole] = useState("viewer");
  const [watch, setWatch] = useState<string[]>(DEFAULT_WATCH);
  const [add, setAdd] = useState("");
  const [brokerId, setBrokerId] = useState<number | "">("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
      if (Array.isArray(saved) && saved.length) setWatch(saved.slice(0, 100));
    } catch {
      /* ignore */
    }
    fetch("/api/auth")
      .then((r) => r.json())
      .then((j: { user?: { role?: string } }) => setRole(j.user?.role ?? "viewer"))
      .catch(() => {});
  }, []);

  const saveWatch = (w: string[]) => {
    setWatch(w);
    localStorage.setItem(STORAGE, JSON.stringify(w));
  };

  const load = useCallback(() => {
    api<FeedInfo>("/api/feed")
      .then((j) => {
        setInfo(j);
        setBrokerId((b) => b || j.settings.feedBrokerId || j.brokers[0]?.id || "");
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const { ticks, status: streamStatus, connected } = useLiveTicks(watch);
  const st = streamStatus ?? info?.status ?? null;
  const isAdmin = role === "admin";

  const act = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      const r = await api<{ ok: boolean; message: string }>("/api/feed", { method: "POST", body: JSON.stringify(body) });
      toast(r.message, r.ok ? "success" : "error");
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  const addSymbol = async () => {
    const sym = add.trim().toUpperCase();
    if (!sym) return;
    if (watch.includes(sym)) return toast(`${sym} already in watchlist`, "info");
    try {
      const r = await api<{ items: { symbol: string }[] }>(`/api/instruments?q=${encodeURIComponent(sym)}&limit=20`);
      if (!r.items.some((i) => i.symbol === sym)) return toast(`${sym} not found — add it in Stock Finder first`, "error");
      saveWatch([...watch, sym]);
      setAdd("");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const live = st?.state === "connected" && !st.simulated;
  const pill =
    st?.state === "connected"
      ? st.simulated
        ? { t: "DEMO · SIMULATED", c: "bg-amber-500/20 text-amber-300 border-amber-500/40" }
        : { t: `LIVE · ${st.provider === "dhan" ? "DHAN" : "ANGEL ONE"}`, c: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" }
      : st?.state === "connecting" || st?.state === "reconnecting"
        ? { t: st.state.toUpperCase(), c: "bg-sky-500/20 text-sky-300 border-sky-500/40" }
        : { t: "OFF · Yahoo ~15 min delay", c: "bg-slate-600/30 text-slate-300 border-slate-500/40" };
  const sync = info?.settings.tokenSync ?? {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">Live Feed · 0-Delay Market Data</h1>
          <p className="text-xs text-slate-400">Broker WebSocket (tick-by-tick) → server hub → browser stream (SSE). Same ticks drive instant SL / Target execution.</p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${pill.c}`}>
          <span className={`inline-block h-2 w-2 rounded-full mr-1.5 ${live ? "bg-emerald-400 animate-pulse" : st?.state === "connected" ? "bg-amber-400 animate-pulse" : "bg-slate-500"}`} />
          {pill.t}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Ticks / sec" value={st ? String(st.ticksPerSec) : "—"} />
        <Stat label="Avg latency" value={st?.avgLatencyMs != null ? `${st.avgLatencyMs} ms` : "—"} sub="exchange → server" />
        <Stat label="Subscriptions" value={st ? String(st.subscriptions) : "—"} />
        <Stat label="Total ticks" value={st ? fmtInt(st.totalTicks) : "—"} />
        <Stat label="Last tick" value={st?.lastTickAt ? exTime(st.lastTickAt) : "—"} />
        <Stat label="Browser stream" value={connected ? "Connected" : "…"} sub={st?.reconnects ? `${st.reconnects} reconnects` : ""} />
      </div>
      {st?.lastError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">Feed error: {st.lastError}</div>}

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="panel p-4 space-y-3">
          <h2 className="font-bold">Connection</h2>
          {!isAdmin && <div className="text-xs text-slate-400">Only an admin can start / stop the feed.</div>}
          <div>
            <label className="label">Feed source (broker account)</label>
            <select className="input" disabled={!isAdmin} value={brokerId} onChange={(e) => setBrokerId(e.target.value ? Number(e.target.value) : "")}>
              {(info?.brokers ?? []).length === 0 && <option value="">No Dhan / Angel One account — add one in Brokers</option>}
              {(info?.brokers ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} · {b.provider === "dhan" ? "Dhan" : "Angel One"} {b.hasToken ? "" : "(no token)"}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-green" disabled={!isAdmin || !brokerId || !!busy} onClick={() => act({ action: "start", brokerId, autoStart: true }, "start")}>
              ⚡ Start Live Feed
            </button>
            <button className="btn" disabled={!isAdmin || !!busy} onClick={() => act({ action: "demo" }, "demo")}>
              Demo ticks
            </button>
            <button className="btn btn-red" disabled={!isAdmin || !!busy || st?.state === "stopped"} onClick={() => act({ action: "stop" }, "stop")}>
              Stop
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" disabled={!isAdmin} checked={!!info?.settings.feedAutoStart} onChange={(e) => act({ action: "autostart", feedAutoStart: e.target.checked }, "auto")} />
            Auto-start live feed when the server starts
          </label>
          <div className="text-[11px] text-slate-500 leading-relaxed">
            <b className="text-slate-300">Dhan:</b> Client ID + Access Token (Data API plan jaruri). <b className="text-slate-300">Angel One:</b> Brokers page par 🔐 Login (JWT + feed token, free). Kotak Neo feed hal supported nathi.
          </div>
        </div>

        <div className="panel p-4 space-y-3">
          <h2 className="font-bold">Scrip Master (tokens)</h2>
          <p className="text-xs text-slate-400">Real securityId / symboltoken, real expiries & strikes for the option chain, and auto-filled tokens for live orders. Sync once a day (new weekly contracts).</p>
          {(["dhan", "angelone"] as const).map((p) => (
            <div key={p} className="flex items-center justify-between gap-2 rounded-lg border border-[#263244] bg-[#0b1220] px-3 py-2">
              <div className="text-xs">
                <div className="font-semibold">{p === "dhan" ? "Dhan" : "Angel One"}</div>
                <div className="text-[10px] text-slate-500">
                  {fmtInt(info?.tokens[p] ?? 0)} instruments · {sync[p]?.at ? new Date(sync[p].at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "never synced"}
                </div>
              </div>
              <button className="btn btn-xs" disabled={!isAdmin || !!busy} onClick={() => act({ action: "sync", provider: p }, `sync-${p}`)}>
                {busy === `sync-${p}` ? "Syncing…" : "⟳ Sync"}
              </button>
            </div>
          ))}
        </div>

        <div className="panel p-4 space-y-2 text-xs text-slate-300 leading-relaxed">
          <h2 className="font-bold text-sm">0-delay kevi rite kaam kare chhe?</h2>
          <div>1. Server broker sathe <b>ek</b> WebSocket rakhe chhe (binary ticks, ~50-300 ms exchange thi).</div>
          <div>2. Har tick turant browser ma push thay chhe (SSE, polling nahi).</div>
          <div>3. Tick aavta j <b>Tick Engine</b> SL / Target / Trailing / Entry check kare chhe — 5 sec ni rah nathi joto.</div>
          <div>4. Feed bandh hoy to automatic Yahoo (~15 min delay) → simulator fallback.</div>
          <div className="text-[10px] text-amber-200/80 pt-1">Note: Exchange → broker → tamara sudhi physical network delay (milliseconds) to rahe j. Demo ticks real nathi.</div>
        </div>
      </div>

      <div className="panel">
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-[#1f2937]">
          <h2 className="font-bold mr-auto">Live Watchlist ({watch.length})</h2>
          <input className="input mono w-40" placeholder="Add symbol" value={add} onChange={(e) => setAdd(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && addSymbol()} />
          <button className="btn btn-xs" onClick={addSymbol}>
            + Add
          </button>
          <button className="btn btn-xs" onClick={() => saveWatch(DEFAULT_WATCH)}>
            Reset
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>LTP</th>
                <th>Chg</th>
                <th>Chg %</th>
                <th>Open / High / Low</th>
                <th>Bid / Ask</th>
                <th>Volume</th>
                <th>OI</th>
                <th>Exch time</th>
                <th>Latency</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {watch.map((sym) => {
                const t = ticks[sym];
                const up = (t?.change ?? 0) >= 0;
                return (
                  <tr key={sym}>
                    <td>
                      <div className="mono font-bold">{sym}</div>
                      {t && <div className={`text-[9px] font-bold ${t.simulated ? "text-amber-300" : "text-emerald-400"}`}>{t.simulated ? "SIMULATED" : `● ${t.provider.toUpperCase()}`}</div>}
                    </td>
                    <td className="mono font-bold text-base">
                      {t ? (
                        <span key={t.flashAt} className={`px-1 rounded ${t.flashAt ? (t.dir === "up" ? "flash-up" : "flash-down") : ""}`}>
                          {fmt(t.ltp)}
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className={`mono ${t ? (up ? "up" : "down") : ""}`}>{t?.change != null ? `${up ? "+" : ""}${fmt(t.change)}` : "—"}</td>
                    <td className={`mono font-semibold ${t ? (up ? "up" : "down") : ""}`}>{t?.changePct != null ? `${up ? "+" : ""}${t.changePct}%` : "—"}</td>
                    <td className="mono text-[11px] text-slate-400">{t ? `${fmt(t.open)} / ${fmt(t.high)} / ${fmt(t.low)}` : "—"}</td>
                    <td className="mono text-[11px]">{t?.bid ? `${fmt(t.bid)} / ${fmt(t.ask)}` : "—"}</td>
                    <td className="mono text-xs">{t?.volume ? fmtInt(t.volume) : "—"}</td>
                    <td className="mono text-xs">{t?.oi ? fmtOi(t.oi) : "—"}</td>
                    <td className="mono text-[11px] text-slate-400">{exTime(t?.exchTs)}</td>
                    <td className={`mono text-[11px] ${t?.latencyMs != null && t.latencyMs > 1000 ? "down" : "up"}`}>{t?.latencyMs != null ? `${t.latencyMs} ms` : "—"}</td>
                    <td>
                      <button className="btn btn-xs" onClick={() => saveWatch(watch.filter((w) => w !== sym))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {st?.state !== "connected" && <div className="p-4 text-center text-xs text-slate-500">Feed off — Start Live Feed (admin) athva Demo ticks thi stream test karo.</div>}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[10px] text-slate-400 uppercase font-semibold">{label}</div>
      <div className="mono text-lg font-bold">{value}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}
