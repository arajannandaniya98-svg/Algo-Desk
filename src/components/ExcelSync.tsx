"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "./utils";
import { toast } from "./Toast";

type Stats = {
  generatedAt: string;
  sheet: string;
  sheets: number;
  sections: string[];
  rows: { setups: number; orders: number; strategies: number; signals: number; total: number };
  capital: { total: number; used: number; free: number; equity: number };
  autoExcelMinutes: number;
  filename: string;
};

export function ExcelSync() {
  const [on, setOn] = useState(false);
  const [serverSave, setServerSave] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [mins, setMins] = useState(5);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStats(await api<Stats>("/api/export/xlsx?stats"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    api<{ settings: { autoExcelMinutes: number } }>("/api/settings")
      .then((r) => setMins(r.settings.autoExcelMinutes || 5))
      .catch(() => {});
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  const saveOnServer = useCallback(async () => {
    const r = await api<{ ok: boolean; message: string; file: string }>("/api/export/xlsx", { method: "POST", body: JSON.stringify({ action: "save" }) });
    setSavedPath(r.file);
    return r;
  }, []);

  const run = useCallback(
    async (auto: boolean) => {
      setBusy(true);
      try {
        if (serverSave) {
          const r = await saveOnServer();
          if (!auto) toast(r.message, "success");
        }
        if (!serverSave || !auto) {
          const res = await fetch("/api/export/xlsx", { cache: "no-store" });
          if (!res.ok) throw new Error("Export failed");
          const blob = await res.blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = stats?.filename ?? "AlgoDesk-Report.xlsx";
          a.click();
          URL.revokeObjectURL(a.href);
          if (auto) toast("Excel auto-updated (1 sheet)", "success");
        }
        setLast(new Date().toLocaleTimeString("en-IN", { hour12: false }));
        refresh();
      } catch (e) {
        toast((e as Error).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [serverSave, saveOnServer, stats?.filename, refresh],
  );

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (on && mins > 0) {
      timer.current = setInterval(() => run(true), Math.max(1, mins) * 60000);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [on, mins, run]);

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">Excel Report</h2>
        <span className={`badge ${on ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700/50 text-slate-300"}`}>{on ? "AUTO ON" : "MANUAL"}</span>
      </div>
      <div className="text-xs text-slate-400 leading-relaxed">
        <b className="text-slate-200">1 Single Sheet Auto Calculation:</b> Entry Price, Exit Price, Capital Used, Calculated Profit/Loss &amp; Total P&amp;L with Excel dynamic SUM formulas. File:{" "}
        <span className="mono text-slate-300">{stats?.filename ?? "AlgoDesk-Report.xlsx"}</span>.
      </div>
      {stats && (
        <div className="grid grid-cols-4 gap-2 text-center">
          <Box label="Signals" value={stats.rows.signals} />
          <Box label="Setups" value={stats.rows.setups} />
          <Box label="Orders" value={stats.rows.orders} />
          <Box label="Rows" value={stats.rows.total} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <button className="btn btn-primary flex-1" disabled={busy} onClick={() => run(false)}>
          {busy ? "Building…" : "⤓ Download .xlsx"}
        </button>
        <button className={`btn ${on ? "btn-green" : ""}`} onClick={() => setOn(!on)}>
          {on ? "Stop Auto" : "Start Auto"}
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-slate-400">Every</span>
        <input className="input mono w-16" type="number" min={1} max={120} value={mins} onChange={(e) => setMins(Math.max(1, Number(e.target.value) || 1))} />
        <span className="text-slate-400">min</span>
        <span className="text-[10px] text-slate-500 ml-auto">
          {stats ? `data ${new Date(stats.generatedAt).toLocaleTimeString("en-IN", { hour12: false })}` : ""}
          {last ? ` · run ${last}` : ""}
        </span>
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={serverSave} onChange={(e) => setServerSave(e.target.checked)} />
        <span>
          Save on server instead of downloading — same file overwritten every time
          {savedPath && <span className="block text-[10px] text-slate-500 mono break-all">{savedPath}</span>}
        </span>
      </label>
      {stats && (
        <div className="text-[10px] text-slate-500 mono">
          Capital ₹{fmt(stats.capital.total, 0)} · Used ₹{fmt(stats.capital.used, 0)} · Equity ₹{fmt(stats.capital.equity, 0)}
        </div>
      )}
    </div>
  );
}

function Box({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[#0b1220] border border-[#263244] py-1.5">
      <div className="text-[9px] text-slate-500 uppercase">{label}</div>
      <div className="mono text-sm font-bold">{value}</div>
    </div>
  );
}
