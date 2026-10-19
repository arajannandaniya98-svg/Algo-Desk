"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "@/db/schema";
import type { CapitalSnapshot } from "@/lib/capital";
import { api, fmt } from "./utils";
import { toast } from "./Toast";

export function CapitalPanel({ compact = false }: { compact?: boolean }) {
  const [snap, setSnap] = useState<CapitalSnapshot | null>(null);
  const [s, setS] = useState<AppSettings | null>(null);
  const [edit, setEdit] = useState(false);
  const editingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ capital: "", riskPerTradePct: "", maxDailyLossPct: "", enforceCapital: true, autoExcelMinutes: 5 });

  const load = useCallback(async () => {
    try {
      const r = await api<{ settings: AppSettings; snapshot: CapitalSnapshot }>("/api/settings");
      setSnap(r.snapshot);
      setS(r.settings);
      // Do not replace what the user is typing during edit mode. The previous
      // 5-second refresh was the reason Capital appeared not to save.
      if (!editingRef.current) {
        setForm({
          capital: String(r.settings.capital),
          riskPerTradePct: String(r.settings.riskPerTradePct),
          maxDailyLossPct: String(r.settings.maxDailyLossPct),
          enforceCapital: r.settings.enforceCapital,
          autoExcelMinutes: r.settings.autoExcelMinutes,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const save = async () => {
    const capital = Number(form.capital);
    const riskPerTradePct = Number(form.riskPerTradePct);
    const maxDailyLossPct = Number(form.maxDailyLossPct);
    if (!Number.isFinite(capital) || capital <= 0) return toast("Capital must be greater than ₹0", "error");
    if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0) return toast("Risk per trade must be greater than 0", "error");
    if (!Number.isFinite(maxDailyLossPct) || maxDailyLossPct <= 0) return toast("Daily loss limit must be greater than 0", "error");
    setSaving(true);
    try {
      const r = await api<{ settings: AppSettings; snapshot: CapitalSnapshot }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ capital, riskPerTradePct, maxDailyLossPct, enforceCapital: form.enforceCapital, autoExcelMinutes: Number(form.autoExcelMinutes) }),
      });
      setS(r.settings);
      setSnap(r.snapshot);
      setForm({
        capital: String(r.settings.capital),
        riskPerTradePct: String(r.settings.riskPerTradePct),
        maxDailyLossPct: String(r.settings.maxDailyLossPct),
        enforceCapital: r.settings.enforceCapital,
        autoExcelMinutes: r.settings.autoExcelMinutes,
      });
      editingRef.current = false;
      setEdit(false);
      toast(`Capital saved: ₹${r.settings.capital.toLocaleString("en-IN")}`, "success");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (!snap || !s) return <div className="panel p-4 text-xs text-slate-500">Loading capital…</div>;
  const usedPct = Math.min(snap.exposurePct, 100);
  const pnl = snap.realized + snap.unrealized;
  const cls = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">Capital & Risk</h2>
        <button
          className="btn btn-xs"
          onClick={() => {
            const next = !edit;
            editingRef.current = next;
            setEdit(next);
          }}
        >
          {edit ? "Close" : "✎ Edit"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] text-slate-400 uppercase font-semibold">Capital</div>
          <div className="mono text-lg font-bold">₹{fmt(snap.capital, 0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-400 uppercase font-semibold">Equity</div>
          <div className={`mono text-lg font-bold ${cls(pnl)}`}>₹{fmt(snap.equity, 0)}</div>
        </div>
      </div>

      <div>
        <div className="flex justify-between text-[11px] mb-1">
          <span className="text-slate-400">
            Margin used <span className="mono text-slate-200">₹{fmt(snap.usedMargin, 0)}</span>
          </span>
          <span className="text-slate-400">
            Free <span className="mono text-emerald-400">₹{fmt(snap.freeMargin, 0)}</span> · {snap.exposurePct}%
          </span>
        </div>
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div className={`h-full ${usedPct > 80 ? "bg-red-500" : usedPct > 50 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${usedPct}%` }} />
        </div>
      </div>

      {!compact && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Mini label="Realized" value={`₹${fmt(snap.realized, 0)}`} cls={cls(snap.realized)} />
          <Mini label="Unrealized" value={`₹${fmt(snap.unrealized, 0)}`} cls={cls(snap.unrealized)} />
          <Mini label="Today" value={`₹${fmt(snap.dayPnl, 0)}`} cls={cls(snap.dayPnl)} />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 text-[10px]">
        <span className="badge bg-slate-700/50 text-slate-300">Risk/trade {s.riskPerTradePct}%</span>
        <span className="badge bg-slate-700/50 text-slate-300">Day loss cap {s.maxDailyLossPct}% (₹{fmt(snap.dayLossLimit, 0)})</span>
        <span className={`badge ${s.enforceCapital ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>Guard {s.enforceCapital ? "ON" : "OFF"}</span>
        {snap.dayLossHit && <span className="badge bg-red-500/20 text-red-300">DAILY LIMIT HIT</span>}
      </div>

      {edit && (
        <div className="space-y-2 border-t border-[#263244] pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Capital (₹)</label>
              <input className="input mono" type="number" value={form.capital} onChange={(e) => setForm({ ...form, capital: e.target.value })} />
            </div>
            <div>
              <label className="label">Risk / trade (%)</label>
              <input className="input mono" type="number" step="0.1" value={form.riskPerTradePct} onChange={(e) => setForm({ ...form, riskPerTradePct: e.target.value })} />
            </div>
            <div>
              <label className="label">Max day loss (%)</label>
              <input className="input mono" type="number" step="0.1" value={form.maxDailyLossPct} onChange={(e) => setForm({ ...form, maxDailyLossPct: e.target.value })} />
            </div>
            <div>
              <label className="label">Excel auto-sync (min)</label>
              <input
                className="input mono"
                type="number"
                min={0}
                max={120}
                value={form.autoExcelMinutes}
                onChange={(e) => setForm({ ...form, autoExcelMinutes: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={form.enforceCapital} onChange={(e) => setForm({ ...form, enforceCapital: e.target.checked })} />
            Block entries when margin &gt; free capital (capital guard)
          </label>
          <button className="btn btn-primary w-full" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-[#0b1220] border border-[#263244] py-1.5">
      <div className="text-[9px] text-slate-500 uppercase">{label}</div>
      <div className={`mono text-sm font-bold ${cls}`}>{value}</div>
    </div>
  );
}
