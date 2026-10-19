"use client";

import { useCallback, useEffect, useState } from "react";
import type { Broker } from "@/db/schema";
import { PROVIDERS, type Provider } from "@/lib/broker-meta";
import { api } from "@/components/utils";
import { toast } from "@/components/Toast";

type Form = Partial<Broker> & { provider: Provider };

const empty = (p: Provider): Form => ({ provider: p, label: PROVIDERS.find((x) => x.id === p)!.name, clientId: "", apiKey: "", apiSecret: "", accessToken: "", totpSecret: "", mobile: "", password: "", mpin: "", mode: "paper", isDefault: false, isActive: true });

export default function BrokersPage() {
  const [rows, setRows] = useState<Broker[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [reveal, setReveal] = useState(false);

  const load = useCallback(() => api<Broker[]>("/api/brokers").then(setRows).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy("save");
    try {
      if (form.id) await api(`/api/brokers/${form.id}`, { method: "PUT", body: JSON.stringify(form) });
      else await api("/api/brokers", { method: "POST", body: JSON.stringify(form) });
      toast("Broker saved", "success");
      setForm(null);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const action = async (b: Broker, a: "test" | "login" | "delete" | "toggle-mode" | "default") => {
    setBusy(`${a}-${b.id}`);
    try {
      if (a === "delete") {
        if (!confirm(`Delete broker "${b.label}"?`)) return;
        await api(`/api/brokers/${b.id}`, { method: "DELETE" });
        toast("Deleted", "info");
      } else if (a === "toggle-mode") {
        const mode = b.mode === "paper" ? "live" : "paper";
        if (mode === "live" && !confirm("Switch to LIVE mode? Real orders will be sent to the broker.")) return;
        await api(`/api/brokers/${b.id}`, { method: "PUT", body: JSON.stringify({ mode }) });
        toast(`${b.label} → ${mode.toUpperCase()} mode`, mode === "live" ? "error" : "success");
      } else if (a === "default") {
        await api(`/api/brokers/${b.id}`, { method: "PUT", body: JSON.stringify({ isDefault: true }) });
        toast("Default broker updated", "success");
      } else {
        const r = await api<{ ok: boolean; message: string }>(`/api/brokers/${b.id}`, { method: "POST", body: JSON.stringify({ action: a }) });
        setResults((s) => ({ ...s, [b.id]: r }));
        toast(r.message, r.ok ? "success" : "error");
      }
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const prov = form ? PROVIDERS.find((p) => p.id === form.provider)! : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">Broker Accounts</h1>
          <p className="text-xs text-slate-400">Manual API setup for Dhan · Angel One SmartAPI · Kotak Neo. Start in Paper mode, switch to Live when ready.</p>
        </div>
        <div className="flex flex-wrap gap-2 justify-end max-w-3xl">
          {PROVIDERS.map((p) => (
            <button key={p.id} className="btn" style={{ borderColor: p.color }} onClick={() => setForm(empty(p.id))}>
              <span className="h-2 w-2 rounded-full inline-block" style={{ background: p.color }} /> + {p.name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 && (
        <div className="panel p-8 text-center text-sm text-slate-400">
          No brokers configured yet. Add <b>Dhan</b>, <b>Angel One</b> or <b>Kotak Neo</b> above. Setups without a broker run in the built-in paper simulator.
        </div>
      )}

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {rows.map((b) => {
          const p = PROVIDERS.find((x) => x.id === b.provider)!;
          const res = results[b.id];
          const connected = !!b.accessToken;
          return (
            <div key={b.id} className="panel p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: p?.color }} />
                    <span className="font-bold">{b.label}</span>
                    {b.isDefault && <span className="badge bg-sky-500/20 text-sky-300">DEFAULT</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {p?.name} · {b.clientId || "no client id"}
                  </div>
                </div>
                <span className={`badge ${b.mode === "live" ? "bg-red-500/20 text-red-300" : "bg-emerald-500/20 text-emerald-300"}`}>{b.mode.toUpperCase()}</span>
              </div>
              <div className="text-xs grid grid-cols-2 gap-1 text-slate-400">
                <div>
                  Token: <span className={connected ? "up" : "down"}>{connected ? "present" : "missing"}</span>
                </div>
                <div>
                  API key: <span className={b.apiKey ? "up" : "text-slate-500"}>{b.apiKey ? "set" : "—"}</span>
                </div>
                <div>Updated: {new Date(b.updatedAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</div>
              </div>
              {res && <div className={`text-xs rounded px-2 py-1 ${res.ok ? "bg-green-500/10 text-green-300" : "bg-red-500/10 text-red-300"}`}>{res.message}</div>}
              <div className="flex flex-wrap gap-1 mt-auto">
                <button className="btn btn-xs" disabled={busy === `login-${b.id}`} onClick={() => action(b, "login")}>
                  🔐 Login
                </button>
                <button className="btn btn-xs" disabled={busy === `test-${b.id}`} onClick={() => action(b, "test")}>
                  Test
                </button>
                <button className="btn btn-xs" onClick={() => setForm({ ...b, provider: b.provider as Provider })}>
                  ✎ Edit
                </button>
                <button className={`btn btn-xs ${b.mode === "paper" ? "" : "btn-green"}`} onClick={() => action(b, "toggle-mode")}>
                  {b.mode === "paper" ? "Go Live" : "To Paper"}
                </button>
                {!b.isDefault && (
                  <button className="btn btn-xs" onClick={() => action(b, "default")}>
                    Set Default
                  </button>
                )}
                <button className="btn btn-xs" onClick={() => action(b, "delete")}>
                  🗑
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Setup guide */}
      <div className="panel p-3 text-xs text-slate-400">
        <b className="text-slate-200">12 brokers supported:</b> Dhan · Angel One · Zerodha · Upstox · Fyers · Shoonya · Flattrade · Alice Blue · 5paisa · ICICI Breeze · Kotak Neo · Delta Exchange (crypto). Badha mate <b>Paper mode</b> broker vagar pan chale chhe. Live orders mate: token/key nakho → <b>Test</b> → green ✓ → pachhi j <b>Go Live</b>. Zerodha/Upstox/Fyers/Flattrade/Breeze na tokens <b>roj</b> navā banavvā pade chhe; Shoonya ma 🔐 Login TOTP thi aapmele session banave chhe. Live data feed mate Dhan athva Angel One jaruri (bija brokers thi orders jay chhe, data nahi).
      </div>
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3 text-xs text-slate-400">
        <div className="panel p-3">
          <div className="font-bold text-slate-200 mb-1">Dhan</div>
          Login at web.dhan.co → Profile → <i>Access DhanHQ APIs</i> → generate token. Paste Client ID + token. Orders need <b>securityId</b> (Broker Token field in setup) from Dhan scrip master.
        </div>
        <div className="panel p-3">
          <div className="font-bold text-slate-200 mb-1">Angel One SmartAPI</div>
          Create app at smartapi.angelbroking.com → API key. Enable TOTP and copy the secret. Enter client code + MPIN + TOTP secret then click <b>Login</b> to fetch JWT. Orders need <b>symboltoken</b>.
        </div>
        <div className="panel p-3">
          <div className="font-bold text-slate-200 mb-1">Delta Exchange (Crypto)</div>
          india.delta.exchange → Account → <i>API Keys</i> → create key with <b>trading</b> permission ane tamaro server IP whitelist karo. Key + Secret paste karo (login jarur nathi). Crypto 24×7 chale chhe; prices <b>USD</b> ma.
        </div>
        <div className="panel p-3">
          <div className="font-bold text-slate-200 mb-1">Kotak Neo</div>
          Register on Neo API portal → consumer key & secret. Enter mobile, password, MPIN and click <b>Login</b> (OTP-less flow via MPIN). Orders use trading symbol (e.g. RELIANCE-EQ).
        </div>
      </div>

      {form && prov && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm" onClick={() => setForm(null)}>
          <div className="panel w-full max-w-xl p-5 mt-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: prov.color }} />
                {form.id ? "Edit" : "Add"} {prov.name}
              </h2>
              <a href={prov.docs} target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:underline">
                API docs ↗
              </a>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label">Account Label</label>
                <input className="input" value={form.label ?? ""} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              </div>
              {prov.fields.map((f) => (
                <div key={String(f.key)} className={f.key === "accessToken" || f.key === "totpSecret" ? "col-span-2" : ""}>
                  <label className="label">{f.label}</label>
                  <input
                    className="input mono"
                    type={f.secret && !reveal ? "password" : "text"}
                    value={(form[f.key] as string) ?? ""}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    placeholder={f.hint}
                    autoComplete="off"
                  />
                  <div className="text-[10px] text-slate-500 mt-0.5">{f.hint}</div>
                </div>
              ))}
              <div>
                <label className="label">Mode</label>
                <select className="input" value={form.mode ?? "paper"} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                  <option value="paper">Paper (simulate)</option>
                  <option value="live">Live (real orders)</option>
                </select>
              </div>
              <div className="flex flex-col gap-2 justify-end text-xs">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={!!form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Default broker for new setups
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show (saved secrets stay masked)
                </label>
              </div>
            </div>
            <div className="mt-3 text-[10px] text-slate-500">🔒 Credentials are encrypted (AES-256-GCM) in the database and never sent back to the browser. Leave •••• to keep a saved value, or clear it and type a new one.</div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy === "save"} onClick={save}>
                Save Broker
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
