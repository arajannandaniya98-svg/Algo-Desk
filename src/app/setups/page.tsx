"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Broker, Setup } from "@/db/schema";
import { api, fmt, statusColor, providerName } from "@/components/utils";
import { SetupForm, type SetupDraft } from "@/components/SetupForm";
import { OptionSetupWizard } from "@/components/OptionSetupWizard";
import { toast } from "@/components/Toast";

type Row = Setup & { ltp: number | null; unrealized: number };
const TABS = ["ALL", "DRAFT", "ACTIVE", "ENTERED", "EXITED", "CANCELLED"];

export default function SetupsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-400">Loading…</div>}>
      <SetupsInner />
    </Suspense>
  );
}

function SetupsInner() {
  const sp = useSearchParams();
  const [rows, setRows] = useState<Row[]>([]);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [tab, setTab] = useState("ALL");
  const [draft, setDraft] = useState<SetupDraft | null>(sp.get("new") ? { symbol: "" } : null);
  const [showWizard, setShowWizard] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api<Row[]>("/api/setups").then(setRows).catch(() => {});
    api<Broker[]>("/api/brokers").then(setBrokers).catch(() => {});
  }, []);
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
    if (action === "delete" && !confirm("Delete this setup?")) return;
    setBusy(id);
    try {
      if (action === "delete") {
        await api(`/api/setups/${id}`, { method: "DELETE" });
        toast("Deleted", "info");
      } else {
        const r = await api<{ ok: boolean; message: string; pnl?: number }>(`/api/setups/${id}`, { method: "POST", body: JSON.stringify({ action }) });
        toast(r.message + (r.pnl != null ? ` · P&L ₹${fmt(r.pnl)}` : ""), r.ok ? "success" : "error");
      }
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const brokerName = (id: number | null) => {
    const b = brokers.find((x) => x.id === id);
    return b ? `${b.label} (${b.mode})` : "Paper";
  };

  const shown = rows.filter((r) => tab === "ALL" || r.status === tab);
  const counts = Object.fromEntries(TABS.map((t) => [t, t === "ALL" ? rows.length : rows.filter((r) => r.status === t).length]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">Algo Setups</h1>
          <p className="text-xs text-slate-400">Manual & rule-based entry/exit · Edit anytime · SL/Target auto-monitored</p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setShowWizard(true)}>
            ⛓ Option Chain Setup
          </button>
          <button className="btn btn-primary" onClick={() => setDraft({ symbol: "" })}>
            + New Setup
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t} className={`btn btn-xs ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>
            {t} <span className="opacity-70">({counts[t]})</span>
          </button>
        ))}
      </div>

      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Status</th>
              <th>Setup / Strategy</th>
              <th>Instrument</th>
              <th>Side / Qty</th>
              <th>Entry Rule</th>
              <th>LTP</th>
              <th>Filled</th>
              <th>SL</th>
              <th>Target</th>
              <th>Trail</th>
              <th>P&L</th>
              <th>Broker</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const pnl = s.status === "ENTERED" ? s.unrealized : s.pnl;
              return (
                <tr key={s.id}>
                  <td>
                    <span className={`badge ${statusColor[s.status]}`}>{s.status}</span>
                    {s.exitReason && <div className="text-[10px] text-slate-500 mt-0.5">{s.exitReason}</div>}
                  </td>
                  <td>
                    <div className="font-semibold">{s.name}</div>
                    <div className="text-[10px] text-slate-500">
                      #{s.id} · {new Date(s.createdAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                      {s.strategyId ? (
                        <a href="/strategy" className="ml-1 text-sky-400 hover:underline">
                          ◈ strategy #{s.strategyId} · leg {s.legIndex + 1}
                        </a>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="mono font-semibold">{s.symbol}</div>
                    <div className="text-[10px] text-slate-400">
                      {s.exchange} · {s.instrumentType}
                      {s.strike ? ` ${s.strike}` : ""} {s.expiry ? `· ${s.expiry}` : ""} · {s.productType}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${s.side === "BUY" ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>{s.side}</span> <span className="mono">{s.quantity}</span>
                  </td>
                  <td className="text-xs">
                    <div>{s.entryTrigger === "MANUAL" ? "Manual" : s.entryTrigger === "PRICE_ABOVE" ? "LTP ≥" : "LTP ≤"}</div>
                    <div className="mono text-slate-400">{s.entryPrice ? fmt(s.entryPrice) : s.orderType}</div>
                  </td>
                  <td className="mono">{fmt(s.ltp)}</td>
                  <td className="mono">
                    {s.entryFilledPrice ? fmt(s.entryFilledPrice) : "—"}
                    {s.exitFilledPrice ? <div className="text-[10px] text-slate-400">→ {fmt(s.exitFilledPrice)}</div> : null}
                  </td>
                  <td className="mono down">{fmt(s.stopLoss)}</td>
                  <td className="mono up">{fmt(s.target)}</td>
                  <td className="mono text-xs">
                    {s.trailingSl ?? "—"}
                    {(s.meta as { trailSl?: number })?.trailSl != null && Number.isFinite((s.meta as { trailSl?: number }).trailSl) && <div className="text-[10px] text-amber-300">@ {fmt((s.meta as { trailSl?: number }).trailSl)}</div>}
                  </td>
                  <td className={`mono font-bold ${pnl > 0 ? "up" : pnl < 0 ? "down" : ""}`}>{s.status === "ENTERED" || s.status === "EXITED" ? `₹${fmt(pnl)}` : "—"}</td>
                  <td className="text-xs">{brokerName(s.brokerId)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {(s.status === "DRAFT" || s.status === "CANCELLED" || s.status === "EXITED") && (
                        <button className="btn btn-xs" disabled={busy === s.id} onClick={() => act(s.id, "activate")} title="Arm setup">
                          ▶ Arm
                        </button>
                      )}
                      {s.status !== "ENTERED" && (
                        <button className="btn btn-xs btn-green" disabled={busy === s.id} onClick={() => act(s.id, "enter")}>
                          ENTER
                        </button>
                      )}
                      {s.status === "ENTERED" && (
                        <button className="btn btn-xs btn-red" disabled={busy === s.id} onClick={() => act(s.id, "exit")}>
                          EXIT
                        </button>
                      )}
                      <button className="btn btn-xs" onClick={() => setDraft(s)}>
                        ✎ Edit
                      </button>
                      {s.status === "ACTIVE" && (
                        <button className="btn btn-xs" onClick={() => act(s.id, "cancel")}>
                          Cancel
                        </button>
                      )}
                      <button className="btn btn-xs" onClick={() => act(s.id, "duplicate")} title="Duplicate">
                        ⧉
                      </button>
                      {s.status !== "ENTERED" && (
                        <>
                          <button className="btn btn-xs" onClick={() => act(s.id, "reset")} title="Reset to draft">
                            ↺
                          </button>
                          <button className="btn btn-xs" onClick={() => act(s.id, "delete")} title="Delete">
                            🗑
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={13} className="text-center text-slate-500 py-10">
                  No setups here. Click <b>+ New Setup</b>, or pick a stock / option strike and press B / S.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel p-3 text-xs text-slate-400 grid md:grid-cols-4 gap-3">
        <div>
          <b className="text-slate-200">DRAFT</b> — saved but inactive. Edit freely.
        </div>
        <div>
          <b className="text-slate-200">ACTIVE</b> — armed. Manual: press ENTER. Auto: engine enters when price rule hits.
        </div>
        <div>
          <b className="text-slate-200">ENTERED</b> — in position. SL / Target / Trailing SL monitored every 5s. Press EXIT to square off manually. Edit SL/Target live.
        </div>
        <div>
          <b className="text-slate-200">EXITED</b> — closed with P&L. Re-arm or duplicate to trade again.
        </div>
      </div>

      {showWizard && (
        <OptionSetupWizard
          onClose={() => setShowWizard(false)}
          onPick={(d) => {
            setShowWizard(false);
            setDraft(d);
          }}
        />
      )}

      {draft && (
        <SetupForm
          initial={draft}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            load();
          }}
        />
      )}
    </div>
  );
}
