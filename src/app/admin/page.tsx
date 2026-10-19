"use client";

import { Fragment, Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/components/utils";
import { toast } from "@/components/Toast";

type Role = "admin" | "trader" | "viewer";
type Account = {
  user: { id: number; username: string; displayName: string; role: Role; totpEnabled: boolean; mustChangePassword: boolean; lastLoginAt: string | null; lastLoginIp: string; passwordChangedAt: string; createdAt: string; mobileMasked?: string; hasMobile?: boolean; emailMasked?: string; hasEmail?: boolean; loginOtpChannel?: string };
  sessions: { id: number; ip: string; userAgent: string; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean }[];
  policy: { passwordMinLength: number; require2faAdmin: boolean; sessionIdleMinutes: number; sessionMaxHours: number };
  needs2fa: boolean;
};
type UserRow = {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  totp_enabled: boolean;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  last_login_ip: string;
  created_at: string;
  sessions: number;
  mobile?: string;
  email?: string;
  login_otp_channel?: string;
};
type SessionRow = { id: number; user_id: number; username: string; role: Role; ip: string; user_agent: string; created_at: string; last_seen_at: string; expires_at: string };
type AuditRow = { id: number; user_id: number | null; username: string; action: string; target: string; detail: string; ip: string; user_agent: string; success: boolean; created_at: string };
type Policy = { sessionIdleMinutes: number; sessionMaxHours: number; maxLoginAttempts: number; lockoutMinutes: number; passwordMinLength: number; require2faAdmin: boolean };
type Overview = { counts: Record<string, number>; settings: Policy; environment: { https: boolean; appSecret: "env" | "file"; envAdminPassword: boolean; nodeEnv: string } };
type Res = { ok: boolean; message?: string; error?: string };

const dt = (v?: string | null) => (v ? new Date(v).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "—");
const ROLE_BADGE: Record<string, string> = { admin: "bg-red-500/20 text-red-300", trader: "bg-sky-500/20 text-sky-300", viewer: "bg-slate-600/30 text-slate-300" };
const uaShort = (ua: string) => {
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl/i.test(ua) ? "curl" : "Browser";
  const o = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${b}${o ? ` · ${o}` : ""}`;
};
const post = (url: string, body: Record<string, unknown>) => api<Res & Record<string, unknown>>(url, { method: "POST", body: JSON.stringify(body) });
async function run(p: Promise<Res>, after?: () => void) {
  try {
    const r = await p;
    toast(r.message ?? "Done", "success");
    after?.();
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

export default function AdminPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-400">Loading…</div>}>
      <AdminInner />
    </Suspense>
  );
}

function AdminInner() {
  const sp = useSearchParams();
  const [account, setAccount] = useState<Account | null>(null);
  const [tab, setTab] = useState(sp.get("tab") ?? "account");
  const loadAccount = useCallback(() => {
    api<Account>("/api/account")
      .then(setAccount)
      .catch((e) => toast((e as Error).message, "error"));
  }, []);
  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  const isAdmin = account?.user.role === "admin";
  const tabs = [
    { id: "account", label: "👤 My Account" },
    ...(isAdmin
      ? [
          { id: "overview", label: "🛡 Security Checklist" },
          { id: "users", label: "👥 Users & Roles" },
          { id: "sessions", label: "💻 Active Sessions" },
          { id: "audit", label: "📜 Audit Log" },
          { id: "policy", label: "⚙ Security Policy" },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{isAdmin ? "Admin Panel & Security" : "My Account & Security"}</h1>
        <p className="text-xs text-slate-400">Username + password (scrypt) · 2FA (TOTP) · roles · session control · lockout · full audit trail</p>
      </div>
      <div className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t.id} className={`btn btn-xs ${tab === t.id ? "btn-primary" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!account ? (
        <div className="text-xs text-slate-500">Loading…</div>
      ) : tab === "account" || !isAdmin ? (
        <AccountTab account={account} reload={loadAccount} />
      ) : tab === "overview" ? (
        <OverviewTab go={setTab} />
      ) : tab === "users" ? (
        <UsersTab meId={account.user.id} minLen={account.policy.passwordMinLength} />
      ) : tab === "sessions" ? (
        <SessionsTab />
      ) : tab === "audit" ? (
        <AuditTab />
      ) : (
        <PolicyTab />
      )}
    </div>
  );
}

// ---------------- My account ----------------
function AccountTab({ account, reload }: { account: Account; reload: () => void }) {
  const u = account.user;
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [enroll, setEnroll] = useState<{ secret: string; qr: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [disable, setDisable] = useState({ password: "", code: "" });

  const changePassword = async () => {
    if (pw.next !== pw.confirm) return toast("New passwords do not match", "error");
    const ok = await run(post("/api/account", { action: "change-password", currentPassword: pw.current, newPassword: pw.next }));
    if (ok) {
      setPw({ current: "", next: "", confirm: "" });
      if (u.mustChangePassword) window.location.href = "/";
      else reload();
    }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      {(u.mustChangePassword || account.needs2fa) && (
        <div className="lg:col-span-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          ⚠ {u.mustChangePassword ? "Admin e tamaro password reset karyo chhe — aagal vadhta pehla navo password set karo." : "Security policy mujab admin mate 2FA farajiyat chhe — niche 2FA chalu karo."}
        </div>
      )}
      <div className="panel p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Profile</h2>
          <span className={`badge ${ROLE_BADGE[u.role]}`}>{u.role.toUpperCase()}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Info k="Username" v={u.username} mono />
          <Info k="Display name" v={u.displayName || "—"} />
          <Info k="Last login" v={dt(u.lastLoginAt)} />
          <Info k="Last login IP" v={u.lastLoginIp || "—"} mono />
          <Info k="Password changed" v={dt(u.passwordChangedAt)} />
          <Info k="2FA" v={u.totpEnabled ? "✓ Enabled" : "✕ Off"} />
          <Info k="Mobile (OTP reset)" v={u.hasMobile ? u.mobileMasked ?? "set" : "— not set"} mono />
        </div>
        <div className="text-[11px] text-slate-500">
          Session: idle {account.policy.sessionIdleMinutes} min auto-logout · max {account.policy.sessionMaxHours} h
        </div>
      </div>

      <div className="panel p-4 space-y-2">
        <h2 className="font-bold">Change Password</h2>
        <input className="input mono" type="password" placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        <input className="input mono" type="password" placeholder={`New password (min ${account.policy.passwordMinLength})`} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        <input className="input mono" type="password" placeholder="Confirm new password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        <button className="btn btn-primary w-full" disabled={!pw.current || !pw.next} onClick={changePassword}>
          Update Password
        </button>
        <p className="text-[10px] text-slate-500">Letters + numbers + UPPERCASE/symbol. Password badalta biji badhi devices logout thashe.</p>
      </div>

      <MobileCard has={!!u.hasMobile} masked={u.mobileMasked ?? ""} reload={reload} />

      <LoginOtpCard hasEmail={!!u.hasEmail} emailMasked={u.emailMasked ?? ""} hasMobile={!!u.hasMobile} mobileMasked={u.mobileMasked ?? ""} channel={u.loginOtpChannel ?? "none"} reload={reload} />

      <div className="panel p-4 space-y-3">
        <h2 className="font-bold">Two-Factor Authentication (2FA)</h2>
        {u.totpEnabled ? (
          <>
            <div className="rounded bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-xs text-emerald-200">✓ 2FA enabled — login mate password + phone code jaruri chhe.</div>
            <div className="text-xs text-slate-400">Disable karva password ane current code aapo:</div>
            <div className="grid grid-cols-2 gap-2">
              <input className="input mono" type="password" placeholder="Password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} />
              <input className="input mono" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value.replace(/\D/g, "") })} />
            </div>
            <button className="btn btn-red w-full" onClick={() => run(post("/api/account", { action: "2fa-disable", ...disable }), () => { setDisable({ password: "", code: "" }); reload(); })}>
              Disable 2FA
            </button>
          </>
        ) : enroll ? (
          <>
            <div className="text-xs text-slate-300">1️⃣ Google Authenticator / Microsoft Authenticator / Authy ma QR scan karo.</div>
            <div className="flex gap-3 items-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enroll.qr} alt="2FA QR code" className="rounded-lg bg-white p-1 w-40 h-40" />
              <div className="text-[11px] text-slate-400 space-y-1 min-w-0">
                <div>Scan na thay to aa key jaate lakho:</div>
                <div className="mono text-slate-100 break-all bg-[#0b1220] rounded p-2 select-all">{enroll.secret}</div>
                <div>Type: Time-based · 6 digits · 30 sec</div>
              </div>
            </div>
            <div className="text-xs text-slate-300">2️⃣ App ma dekhato 6-digit code lakho:</div>
            <div className="flex gap-2">
              <input className="input mono text-center tracking-[0.4em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
              <button className="btn btn-green" disabled={code.length !== 6} onClick={() => run(post("/api/account", { action: "2fa-enable", code }), () => { setEnroll(null); setCode(""); reload(); })}>
                Verify & Enable
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-xs text-slate-400">Password chorai jay to pan phone na code vagar koi login nahi kari shake. Admin account mate jarur chalu karo.</div>
            <button
              className="btn btn-primary w-full"
              onClick={async () => {
                try {
                  const r = await post("/api/account", { action: "2fa-init" });
                  setEnroll({ secret: String(r.secret), qr: String(r.qr), uri: String(r.uri) });
                } catch (e) {
                  toast((e as Error).message, "error");
                }
              }}
            >
              🔐 Enable 2FA
            </button>
          </>
        )}
      </div>

      <div className="panel p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-bold">My Sessions ({account.sessions.length})</h2>
          {account.sessions.length > 1 && (
            <button className="btn btn-xs" onClick={() => run(post("/api/account", { action: "logout-others" }), reload)}>
              Logout other devices
            </button>
          )}
        </div>
        <div className="space-y-2">
          {account.sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 text-xs border-b border-[#16202e] pb-2">
              <div>
                <div className="font-semibold">
                  {uaShort(s.userAgent)} {s.current && <span className="badge bg-emerald-500/20 text-emerald-300 ml-1">THIS DEVICE</span>}
                </div>
                <div className="text-[10px] text-slate-500 mono">
                  {s.ip} · active {dt(s.lastSeenAt)} · expires {dt(s.expiresAt)}
                </div>
              </div>
              {!s.current && (
                <button className="btn btn-xs" onClick={() => run(post("/api/account", { action: "revoke-session", id: s.id }), reload)}>
                  Sign out
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MobileCard({ has, masked, reload }: { has: boolean; masked: string; reload: () => void }) {
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const save = async (remove = false) => {
    const ok = await run(post("/api/account", { action: "set-mobile", mobile: remove ? "" : mobile, password }));
    if (ok) {
      setMobile("");
      setPassword("");
      reload();
    }
  };
  return (
    <div className="panel p-4 space-y-2">
      <h2 className="font-bold">📲 Mobile — Forgot-password OTP</h2>
      <div className="text-xs text-slate-400">
        {has ? `Registered: ${masked}. Login page par "Forgot password?" thi aa number par OTP aavshe.` : "Mobile save karo etle password bhuli jao to login page parthi OTP vade reset kari shakasho."}
        {" "}SMS provider .env ma set na hoy to OTP server console ma chhapay chhe.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input className="input mono" inputMode="numeric" placeholder="98XXXXXXXX (10 digit)" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/[^\d+ ]/g, ""))} />
        <input className="input mono" type="password" placeholder="Current password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary flex-1" disabled={!mobile || !password} onClick={() => save(false)}>
          Save Mobile
        </button>
        {has && (
          <button className="btn" disabled={!password} onClick={() => save(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function LoginOtpCard({ hasEmail, emailMasked, hasMobile, mobileMasked, channel, reload }: { hasEmail: boolean; emailMasked: string; hasMobile: boolean; mobileMasked: string; channel: string; reload: () => void }) {
  const [email, setEmail] = useState("");
  const [pw1, setPw1] = useState("");
  const [sel, setSel] = useState(channel);
  const [pw2, setPw2] = useState("");
  useEffect(() => setSel(channel), [channel]);
  return (
    <div className="panel p-4 space-y-3">
      <h2 className="font-bold">✉️ Login Confirmation OTP (Gmail / Mobile / Both)</h2>
      <div className="text-xs text-slate-400">
        Chalu karsho to password sachi hoy pachhi pan email/SMS no 6-digit OTP aapvo padshe. Gmail mate .env ma SMTP_HOST/USER/PASS (app password) set karo — na hoy to OTP server console ma chhapay chhe.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="label">Email {hasEmail && <span className="text-emerald-400 normal-case">✓ {emailMasked}</span>}</label>
          <input className="input mono" type="email" placeholder="you@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="label">Current password</label>
          <input className="input mono" type="password" autoComplete="current-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
        </div>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={!email || !pw1} onClick={() => run(post("/api/account", { action: "set-email", email, password: pw1 }), () => { setEmail(""); setPw1(""); reload(); })}>
          Save Email
        </button>
        {hasEmail && (
          <button className="btn" disabled={!pw1} onClick={() => run(post("/api/account", { action: "set-email", email: "", password: pw1 }), () => { setPw1(""); reload(); })}>
            Remove
          </button>
        )}
      </div>
      <div className="border-t border-[#263244] pt-3 grid grid-cols-2 gap-2 items-end">
        <div>
          <label className="label">Confirmation channel</label>
          <select className="input" value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="none">Off — password{channel !== "none" ? "" : " (current)"} only</option>
            <option value="email" disabled={!hasEmail}>Email OTP {hasEmail ? `(${emailMasked})` : "— save email first"}</option>
            <option value="mobile" disabled={!hasMobile}>Mobile OTP {hasMobile ? `(${mobileMasked})` : "— save mobile first"}</option>
            <option value="both" disabled={!hasEmail || !hasMobile}>Both — email + mobile</option>
          </select>
        </div>
        <div>
          <label className="label">Current password</label>
          <input className="input mono" type="password" autoComplete="current-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary w-full" disabled={!pw2 || sel === channel} onClick={() => run(post("/api/account", { action: "login-otp-channel", channel: sel, password: pw2 }), () => { setPw2(""); reload(); })}>
        Save Channel {sel !== channel ? `(${channel} → ${sel})` : ""}
      </button>
    </div>
  );
}

function Info({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="rounded bg-[#0b1220] border border-[#1f2937] px-2 py-1.5">
      <div className="text-[9px] uppercase text-slate-500">{k}</div>
      <div className={`${mono ? "mono" : ""} text-slate-100 truncate`}>{v}</div>
    </div>
  );
}

// ---------------- Overview / checklist ----------------
type SystemCheck = { id: string; label: string; status: "ok" | "warn" | "fail"; detail: string; hint?: string };
type SystemInfo = { summary: Record<string, number>; checks: SystemCheck[]; checkedMs: number; counts: Record<string, number> };

function OverviewTab({ go }: { go: (t: string) => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [repairing, setRepairing] = useState(false);
  const loadSys = useCallback(() => {
    api<SystemInfo>("/api/system")
      .then(setSys)
      .catch(() => {});
  }, []);
  const repair = async () => {
    setRepairing(true);
    try {
      const r = await fetch("/api/system", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "repair" }) });
      const j = (await r.json()) as { ok?: boolean; message?: string };
      toast(j.message ?? "Done", j.ok ? "success" : "error");
      loadSys();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRepairing(false);
    }
  };
  useEffect(() => {
    api<Overview>("/api/admin?view=overview")
      .then(setO)
      .catch((e) => toast((e as Error).message, "error"));
  }, []);
  useEffect(() => {
    loadSys();
  }, [loadSys]);
  if (!o) return <div className="text-xs text-slate-500">Loading…</div>;
  const c = o.counts;
  const items: { ok: boolean | null; title: string; detail: string; fix?: string; tab?: string }[] = [
    { ok: true, title: "Username + password login (no shared password)", detail: "scrypt hashing (N=32768) · generic errors · constant-time compare" },
    { ok: c.admins > 0 && c.admins_2fa === c.admins, title: "2FA on every admin account", detail: `${c.admins_2fa}/${c.admins} admin(s) have 2FA`, fix: "My Account → Enable 2FA", tab: "account" },
    { ok: o.settings.require2faAdmin, title: "Require 2FA for admins (policy)", detail: o.settings.require2faAdmin ? "Enforced" : "Not enforced", fix: "Security Policy → Require 2FA", tab: "policy" },
    { ok: o.settings.passwordMinLength >= 10, title: "Strong password policy", detail: `min ${o.settings.passwordMinLength} chars + letters/numbers/UPPER or symbol + common-password block` },
    { ok: o.settings.maxLoginAttempts <= 5, title: "Brute-force protection", detail: `lock after ${o.settings.maxLoginAttempts} fails for ${o.settings.lockoutMinutes} min · 10 attempts/15 min per IP`, tab: "policy" },
    { ok: o.settings.sessionIdleMinutes <= 240 && o.settings.sessionMaxHours <= 24, title: "Session timeouts", detail: `idle ${o.settings.sessionIdleMinutes} min · max ${o.settings.sessionMaxHours} h · httpOnly cookie, revocable`, tab: "policy" },
    { ok: o.environment.https, title: "HTTPS (encrypted connection)", detail: o.environment.https ? "This session uses HTTPS ✓" : "Plain HTTP — fine on a home PC, NOT on a VPS", fix: "VPS: nginx + certbot (Let's Encrypt) or Cloudflare" },
    { ok: o.environment.appSecret === "env", title: "Broker API keys encrypted (AES-256-GCM)", detail: o.environment.appSecret === "env" ? "Key from APP_SECRET in .env" : "Auto key file .algodesk/secret.key", fix: "node scripts/admin-cli.mjs init-env → restart" },
    { ok: !o.environment.envAdminPassword, title: "No plaintext admin password in .env", detail: o.environment.envAdminPassword ? "ADMIN_PASSWORD / APP_PASSWORD still set in .env" : "Clean", fix: "Remove ADMIN_PASSWORD from .env after first login" },
    { ok: c.users > 1 || null, title: "Separate accounts per person (least privilege)", detail: `${c.users} user(s) — give family/staff Trader or Viewer roles, never share admin`, tab: "users" },
    { ok: null, title: "Firewall + static IP whitelist at broker", detail: "VPS: ufw allow only SSH + 443 · register server IP in Dhan / Angel / Kotak API portal" },
    { ok: null, title: "Daily database backup", detail: "pg_dump app_db > backup.sql (keep .env / APP_SECRET backup safely too)" },
  ];
  const score = items.filter((i) => i.ok === true).length;
  const scorable = items.filter((i) => i.ok !== null).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        <Stat label="Security score" value={`${score}/${scorable}`} cls={score >= scorable - 1 ? "up" : score >= scorable / 2 ? "text-amber-300" : "down"} />
        <Stat label="Users (active)" value={`${c.active_users}/${c.users}`} />
        <Stat label="Active sessions" value={String(c.sessions)} />
        <Stat label="Logins 24h" value={String(c.logins_24h)} />
        <Stat label="Failed events 24h" value={String(c.failed_24h)} cls={c.failed_24h > 10 ? "down" : ""} />
        <Stat label="Locked accounts" value={String(c.locked)} cls={c.locked ? "down" : ""} />
      </div>
      {sys && (
        <div className="panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="font-bold">System Check</h2>
            <div className="flex gap-2">
              <button className="btn btn-xs" onClick={loadSys}>
                ↻ Re-check
              </button>
              <button className="btn btn-xs" disabled={repairing} onClick={repair}>
                {repairing ? "Repairing…" : "🛠 Repair database"}
              </button>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {sys.checks.map((c) => (
              <div key={c.id} className={`rounded-lg border p-2.5 ${c.status === "ok" ? "border-emerald-500/30 bg-emerald-500/5" : c.status === "warn" ? "border-amber-500/30 bg-amber-500/5" : "border-red-500/40 bg-red-500/10"}`}>
                <div className="flex items-center gap-2">
                  <span className={`h-4 w-4 rounded-full flex items-center justify-center text-[10px] font-black text-white ${c.status === "ok" ? "bg-emerald-500" : c.status === "warn" ? "bg-amber-500" : "bg-red-500"}`}>
                    {c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✕"}
                  </span>
                  <span className="text-xs font-semibold">{c.label}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-300 mono break-words">{c.detail}</div>
                {c.hint && <div className="text-[10px] text-slate-400 mt-0.5">→ {c.hint}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="panel p-4">
        <h2 className="font-bold mb-1">Strong security mate shu jaruri chhe? — live checklist</h2>
        <p className="text-xs text-slate-400 mb-3">Green = done · Amber = karvanu baki · Grey = manual (server/broker side)</p>
        <div className="space-y-2">
          {items.map((i) => (
            <div key={i.title} className={`rounded-lg border p-3 flex items-start gap-3 ${i.ok === true ? "border-emerald-500/30 bg-emerald-500/5" : i.ok === false ? "border-amber-500/40 bg-amber-500/10" : "border-[#263244] bg-[#0b1220]"}`}>
              <span className={`mt-0.5 h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-black ${i.ok === true ? "bg-emerald-500 text-white" : i.ok === false ? "bg-amber-500 text-black" : "bg-slate-600 text-white"}`}>
                {i.ok === true ? "✓" : i.ok === false ? "!" : "•"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{i.title}</div>
                <div className="text-xs text-slate-400">{i.detail}</div>
                {i.ok === false && i.fix && <div className="text-[11px] text-amber-200 mt-0.5">→ {i.fix}</div>}
              </div>
              {i.tab && i.ok !== true && (
                <button className="btn btn-xs" onClick={() => go(i.tab!)}>
                  Fix →
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[10px] text-slate-400 uppercase font-semibold">{label}</div>
      <div className={`mono text-lg font-bold ${cls}`}>{value}</div>
    </div>
  );
}

// ---------------- Users ----------------
function UsersTab({ meId, minLen }: { meId: number; minLen: number }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [f, setF] = useState({ username: "", displayName: "", role: "trader" as Role, password: "", mobile: "", email: "", mustChangePassword: true });
  const [createdShare, setCreatedShare] = useState<{
    username: string;
    displayName: string;
    role: Role;
    password: string;
    mobile?: string;
    email?: string;
    loginUrl: string;
  } | null>(null);

  const load = useCallback(() => {
    api<{ items: UserRow[] }>("/api/admin?view=users")
      .then((r) => setRows(r.items))
      .catch((e) => toast((e as Error).message, "error"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const act = (body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    void run(post("/api/admin", body), load);
  };
  const genPassword = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    const p = Array.from(arr, (n) => chars[n % chars.length]).join("") + "A7@";
    setF({ ...f, password: p });
  };

  const handleCreateUser = async () => {
    const creds = { ...f };
    const ok = await run(post("/api/admin", { action: "create-user", ...creds }), () => {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const loginUrl = `${origin}/login`;
      setCreatedShare({
        username: creds.username,
        displayName: creds.displayName || creds.username,
        role: creds.role,
        password: creds.password,
        mobile: creds.mobile || undefined,
        email: creds.email || undefined,
        loginUrl,
      });
      setF({ username: "", displayName: "", role: "trader", password: "", mobile: "", email: "", mustChangePassword: true });
      load();
    });
  };

  return (
    <div className="space-y-4">
      {/* Share Trader Credentials Modal / Card */}
      {createdShare && (
        <ShareCredentialsCard
          creds={createdShare}
          onClose={() => setCreatedShare(null)}
        />
      )}

      <div className="panel p-4 space-y-3">
        <h2 className="font-bold text-base flex items-center gap-2">
          <span>➕ Add New Trader / User</span>
          <span className="badge bg-sky-500/20 text-sky-300 text-[10px]">Instant Shareable Credentials</span>
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <div>
            <label className="label">Username (Login ID)</label>
            <input className="input mono" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} placeholder="e.g. trader1" />
          </div>
          <div>
            <label className="label">Display name</label>
            <input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder="Trader Name" />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
              <option value="trader">Trader (trade, broker login)</option>
              <option value="viewer">Viewer (read only)</option>
              <option value="admin">Admin (full control)</option>
            </select>
          </div>
          <div>
            <label className="label">Mobile (Optional)</label>
            <input className="input mono" inputMode="numeric" placeholder="98XXXXXXXX" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/[^\d]/g, "").slice(0, 10) })} />
          </div>
          <div>
            <label className="label">Email (Optional)</label>
            <input className="input mono" type="email" placeholder="trader@gmail.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div className="col-span-2 md:col-span-1">
            <label className="label">Password (min {minLen})</label>
            <div className="flex gap-1">
              <input className="input mono text-xs" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="Secret" />
              <button type="button" className="btn btn-xs" onClick={genPassword} title="Generate strong password">
                🎲
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#1f2937]">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={f.mustChangePassword} onChange={(e) => setF({ ...f, mustChangePassword: e.target.checked })} />
            Force trader to set their own private password on first login
          </label>

          <button
            className="btn btn-primary font-bold px-4"
            disabled={!f.username || !f.password}
            onClick={handleCreateUser}
          >
            + Create &amp; Share Login Link
          </button>
        </div>
        <div className="text-[10px] text-slate-500">
          User બન્યા પછી તરત જ **WhatsApp / Email / Copy** દ્વારા Login Link અને Username/Password એક ક્લિકમાં મોકલી શકાશે.
        </div>
      </div>

      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>2FA</th>
              <th>Last login</th>
              <th>Sessions</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const locked = !!u.locked_until && new Date(u.locked_until) > new Date();
              const self = u.id === meId;
              return (
                <Fragment key={u.id}>
                <tr>
                  <td>
                    <div className="font-semibold mono">
                      {u.username} {self && <span className="badge bg-emerald-500/20 text-emerald-300">YOU</span>}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {u.display_name || "—"} · since {dt(u.created_at)}
                    </div>
                  </td>
                  <td>
                    <select className="input py-1 text-xs w-28" value={u.role} disabled={self} onChange={(e) => act({ action: "update-user", id: u.id, role: e.target.value })}>
                      <option value="viewer">viewer</option>
                      <option value="trader">trader</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="text-xs space-x-1">
                    <span className={`badge ${u.is_active ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>{u.is_active ? "ACTIVE" : "DISABLED"}</span>
                    {locked && <span className="badge bg-red-500/20 text-red-300">LOCKED</span>}
                    {u.must_change_password && <span className="badge bg-amber-500/20 text-amber-300">PW RESET</span>}
                  </td>
                  <td>{u.totp_enabled ? <span className="badge bg-emerald-500/20 text-emerald-300">ON</span> : <span className="badge bg-slate-600/30 text-slate-400">off</span>}</td>
                  <td className="text-xs">
                    {dt(u.last_login_at)}
                    <div className="text-[10px] text-slate-500 mono">{u.last_login_ip}</div>
                  </td>
                  <td className="mono text-xs">{u.sessions}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <button className="btn btn-xs" onClick={() => setEditId(editId === u.id ? null : u.id)}>
                        ✎ Edit / Share
                      </button>
                      <button
                        className="btn btn-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        title="Share login link and details on WhatsApp"
                        onClick={() => {
                          const origin = typeof window !== "undefined" ? window.location.origin : "";
                          const shareText = `🚀 *AlgoDesk Trading Terminal*\n\n` +
                            `👤 *User:* ${u.display_name || u.username}\n` +
                            `🔑 *Username:* ${u.username}\n` +
                            `🛡️ *Role:* ${u.role.toUpperCase()}\n` +
                            `🌐 *Login Link:* ${origin}/login\n`;
                          window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`, "_blank");
                        }}
                      >
                        💬 WhatsApp
                      </button>
                      {locked && (
                        <button className="btn btn-xs" onClick={() => act({ action: "unlock", id: u.id })}>
                          Unlock
                        </button>
                      )}
                      {u.totp_enabled && !self && (
                        <button className="btn btn-xs" onClick={() => act({ action: "disable-2fa", id: u.id }, `Remove 2FA for ${u.username}? (lost phone)`)}>
                          Reset 2FA
                        </button>
                      )}
                      {u.sessions > 0 && !self && (
                        <button className="btn btn-xs" onClick={() => act({ action: "logout-user", id: u.id })}>
                          Logout
                        </button>
                      )}
                      {!self && (
                        <button className="btn btn-xs" onClick={() => act({ action: "update-user", id: u.id, isActive: !u.is_active })}>
                          {u.is_active ? "Disable" : "Enable"}
                        </button>
                      )}
                      {!self && (
                        <button className="btn btn-xs" onClick={() => act({ action: "delete-user", id: u.id }, `Delete user ${u.username} permanently?`)}>
                          🗑
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {editId === u.id && (
                  <tr>
                    <td colSpan={7} className="bg-[#0b1220]">
                      <EditUserPanel user={u} minLen={minLen} onDone={() => { setEditId(null); load(); }} onCancel={() => setEditId(null)} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ShareCredentialsCard({
  creds,
  onClose,
}: {
  creds: {
    username: string;
    displayName: string;
    role: string;
    password: string;
    mobile?: string;
    email?: string;
    loginUrl: string;
  };
  onClose: () => void;
}) {
  const shareText = `🚀 *AlgoDesk Trading Terminal — Login Details*\n\n` +
    `👤 *Name:* ${creds.displayName}\n` +
    `🔑 *Username:* ${creds.username}\n` +
    `🔒 *Password:* ${creds.password}\n` +
    `🛡️ *Role:* ${creds.role.toUpperCase()}\n` +
    `🌐 *Login Link:* ${creds.loginUrl}\n\n` +
    `_Note: Login thaya pachhi tamaro potano password badli levo._`;

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      toast("Full credentials message copied to clipboard! ✓", "success");
    } catch {
      toast("Copy failed — please copy manually", "error");
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(creds.loginUrl);
      toast("Login link copied! ✓", "success");
    } catch {
      toast("Copy failed", "error");
    }
  };

  const shareWhatsApp = () => {
    const encoded = encodeURIComponent(shareText);
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  };

  return (
    <div className="rounded-xl border border-emerald-500/50 bg-[#0d1c2b] p-4 shadow-xl space-y-3">
      <div className="flex items-center justify-between border-b border-[#1f2937] pb-2">
        <div className="flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center font-black text-xs">
            ✓
          </span>
          <span className="font-bold text-sm text-white">
            Trader Created Successfully! Share Login Details
          </span>
        </div>
        <button className="btn btn-xs" onClick={onClose}>
          ✕ Close
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
        <div className="p-2.5 rounded-lg bg-[#07111c] border border-[#1e2e42] space-y-1">
          <span className="text-[10px] text-slate-400 uppercase font-semibold block">Username (Login ID)</span>
          <span className="mono text-sm font-bold text-sky-300 block select-all">{creds.username}</span>
        </div>

        <div className="p-2.5 rounded-lg bg-[#07111c] border border-[#1e2e42] space-y-1">
          <span className="text-[10px] text-slate-400 uppercase font-semibold block">Password</span>
          <span className="mono text-sm font-bold text-emerald-300 block select-all">{creds.password}</span>
        </div>

        <div className="p-2.5 rounded-lg bg-[#07111c] border border-[#1e2e42] space-y-1">
          <span className="text-[10px] text-slate-400 uppercase font-semibold block">Role</span>
          <span className="badge bg-sky-500/20 text-sky-300 font-bold uppercase">{creds.role}</span>
        </div>
      </div>

      <div className="p-2.5 rounded-lg bg-[#07111c] border border-[#1e2e42] text-xs flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[10px] text-slate-400 uppercase font-semibold block">Login URL</span>
          <span className="mono text-slate-200 truncate block select-all">{creds.loginUrl}</span>
        </div>
        <button className="btn btn-xs bg-[#172338] hover:bg-[#20314d] text-sky-300 border-sky-500/30" onClick={copyLink}>
          ⧉ Copy Link
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button className="btn btn-green font-bold text-xs flex items-center gap-1.5 px-4" onClick={shareWhatsApp}>
          <span>💬 Share via WhatsApp</span>
        </button>

        <button className="btn btn-primary font-bold text-xs flex items-center gap-1.5" onClick={copyAll}>
          <span>📋 Copy Full Message</span>
        </button>

        <button className="btn btn-xs ml-auto text-slate-400" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

function EditUserPanel({ user, minLen, onDone, onCancel }: { user: UserRow; minLen: number; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ username: user.username, displayName: user.display_name ?? "", mobile: user.mobile ?? "", email: user.email ?? "", newPassword: "", mustChangePassword: true });
  const [show, setShow] = useState(true);
  const gen = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%";
    const arr = new Uint32Array(12);
    crypto.getRandomValues(arr);
    setF({ ...f, newPassword: Array.from(arr, (n) => chars[n % chars.length]).join("") + "A7@" });
    setShow(true);
  };
  const copyPw = async () => {
    try {
      await navigator.clipboard.writeText(f.newPassword);
      toast("Password copied — share it safely with the user", "success");
    } catch {
      toast("Copy failed — select and copy manually", "error");
    }
  };
  const save = () =>
    run(post("/api/admin", { action: "edit-user", id: user.id, username: f.username, displayName: f.displayName, mobile: f.mobile, email: f.email, newPassword: f.newPassword || undefined, mustChangePassword: f.mustChangePassword }), onDone);

  const shareExisting = () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const loginUrl = `${origin}/login`;
    const shareText = `🚀 *AlgoDesk Trading Terminal — Account Details*\n\n` +
      `👤 *Name:* ${f.displayName || user.username}\n` +
      `🔑 *Username:* ${f.username}\n` +
      (f.newPassword ? `🔒 *New Password:* ${f.newPassword}\n` : `🔒 *Password:* (Keep previous password or reset above)\n`) +
      `🛡️ *Role:* ${user.role.toUpperCase()}\n` +
      `🌐 *Login Link:* ${loginUrl}\n`;

    const encoded = encodeURIComponent(shareText);
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  };

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold text-slate-300">✎ Edit user #{user.id} — username / password / contact</div>
        <button type="button" className="btn btn-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" onClick={shareExisting}>
          💬 Share on WhatsApp
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div>
          <label className="label">Username (login ID)</label>
          <input className="input mono" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} />
        </div>
        <div>
          <label className="label">Display name</label>
          <input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
        </div>
        <div>
          <label className="label">Mobile (OTP reset)</label>
          <input className="input mono" inputMode="numeric" placeholder="98XXXXXXXX" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/[^\d]/g, "").slice(0, 10) })} />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input mono" type="email" placeholder="user@gmail.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
        <div className="md:col-span-2">
          <label className="label">New password (khali rakho = badlavu nathi) · min {minLen}</label>
          <div className="flex gap-1">
            <input className="input mono" type={show ? "text" : "password"} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} placeholder="— unchanged —" />
            <button type="button" className="btn btn-xs" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
            <button type="button" className="btn btn-xs" onClick={gen} title="Generate strong password">🎲</button>
            <button type="button" className="btn btn-xs" disabled={!f.newPassword} onClick={copyPw} title="Copy password">⧉</button>
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Juno password joi shakato nathi (hash). Navo set kari ne ⧉ copy karo ane user ne aapo.</div>
        </div>
        <label className="flex items-center gap-2 text-xs pb-2">
          <input type="checkbox" checked={f.mustChangePassword} onChange={(e) => setF({ ...f, mustChangePassword: e.target.checked })} />
          First login par user pote navo password rakhe
        </label>
        <div className="flex gap-2 pb-1">
          <button className="btn btn-primary flex-1" onClick={save}>💾 Save</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Sessions ----------------
function SessionsTab() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const load = useCallback(() => {
    api<{ items: SessionRow[]; current: number }>("/api/admin?view=sessions")
      .then((r) => {
        setRows(r.items);
        setCurrent(r.current);
      })
      .catch((e) => toast((e as Error).message, "error"));
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  return (
    <div className="panel overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>User</th>
            <th>Device</th>
            <th>IP</th>
            <th>Started</th>
            <th>Last active</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>
                <span className="mono font-semibold">{s.username}</span> <span className={`badge ${ROLE_BADGE[s.role]}`}>{s.role}</span>
              </td>
              <td className="text-xs">
                {uaShort(s.user_agent)} {s.id === current && <span className="badge bg-emerald-500/20 text-emerald-300">YOU</span>}
              </td>
              <td className="mono text-xs">{s.ip}</td>
              <td className="text-xs">{dt(s.created_at)}</td>
              <td className="text-xs">{dt(s.last_seen_at)}</td>
              <td className="text-xs">{dt(s.expires_at)}</td>
              <td>
                {s.id !== current && (
                  <button className="btn btn-xs btn-red" onClick={() => run(post("/api/admin", { action: "revoke-session", sessionId: s.id }), load)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="text-center text-slate-500 py-6">
                No active sessions
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- Audit ----------------
function AuditTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [q, setQ] = useState("");
  const [success, setSuccess] = useState("");
  const load = useCallback(() => {
    const p = new URLSearchParams({ view: "audit", limit: "500" });
    if (q) p.set("q", q);
    if (success) p.set("success", success);
    api<{ items: AuditRow[] }>(`/api/admin?${p}`)
      .then((r) => setRows(r.items))
      .catch((e) => toast((e as Error).message, "error"));
  }, [q, success]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["id", "time", "user", "action", "target", "detail", "ip", "success", "user_agent"].join(","), ...rows.map((r) => [r.id, r.created_at, r.username, r.action, r.target, r.detail, r.ip, r.success, r.user_agent].map(esc).join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `algodesk-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };
  return (
    <div className="space-y-3">
      <div className="panel p-3 flex flex-wrap gap-2 items-center">
        <input className="input w-64" placeholder="Search action / user / IP / detail…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-36" value={success} onChange={(e) => setSuccess(e.target.value)}>
          <option value="">All results</option>
          <option value="0">Failures only</option>
          <option value="1">Success only</option>
        </select>
        <button className="btn" onClick={load}>
          ↻
        </button>
        <button className="btn" onClick={exportCsv}>
          ⤓ CSV
        </button>
        <button className="btn ml-auto" onClick={() => confirm("Delete audit entries older than 90 days?") && run(post("/api/admin", { action: "clear-audit", olderThanDays: 90 }), load)}>
          Purge &gt; 90 days
        </button>
      </div>
      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Detail</th>
              <th>IP</th>
              <th>Device</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.success ? "" : "bg-red-500/5"}>
                <td className="mono text-[11px]">{new Date(r.created_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "medium" })}</td>
                <td className="mono text-xs">{r.username || "—"}</td>
                <td className="text-xs">
                  <span className={`font-semibold ${r.success ? "" : "down"}`}>{r.action}</span>
                </td>
                <td className="text-[11px] text-slate-400 max-w-[320px] truncate" title={`${r.target} ${r.detail}`}>
                  {[r.target, r.detail].filter(Boolean).join(" · ") || "—"}
                </td>
                <td className="mono text-[11px]">{r.ip}</td>
                <td className="text-[11px] text-slate-500">{uaShort(r.user_agent)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-6">
                  No audit entries
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- Policy ----------------
function PolicyTab() {
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => {
    api<{ settings: Policy }>("/api/admin?view=security")
      .then((r) => setP(r.settings))
      .catch((e) => toast((e as Error).message, "error"));
  }, []);
  if (!p) return <div className="text-xs text-slate-500">Loading…</div>;
  const num = (k: keyof Policy, label: string, hint: string, min: number, max: number) => (
    <div>
      <label className="label">{label}</label>
      <input className="input mono" type="number" min={min} max={max} value={Number(p[k])} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} />
      <div className="text-[10px] text-slate-500 mt-0.5">{hint}</div>
    </div>
  );
  return (
    <div className="panel p-4 space-y-4 max-w-3xl">
      <div className="grid md:grid-cols-3 gap-3">
        {num("sessionIdleMinutes", "Idle logout (minutes)", "No activity → auto logout (5-1440)", 5, 1440)}
        {num("sessionMaxHours", "Max session (hours)", "Re-login required after (1-720)", 1, 720)}
        {num("passwordMinLength", "Min password length", "Recommended 12+ (8-64)", 8, 64)}
        {num("maxLoginAttempts", "Failed attempts before lock", "Recommended 5 (3-20)", 3, 20)}
        {num("lockoutMinutes", "Lockout duration (minutes)", "1-1440", 1, 1440)}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={p.require2faAdmin} onChange={(e) => setP({ ...p, require2faAdmin: e.target.checked })} />
        Require 2FA for all <b>admin</b> accounts (admins without 2FA must enrol before using the app)
      </label>
      <button className="btn btn-primary" onClick={() => run(post("/api/admin", { action: "security", ...p }))}>
        Save Security Policy
      </button>

      <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 space-y-2">
        <div className="font-bold text-red-300">⚠ Danger Zone — Factory Reset</div>
        <div className="text-xs text-slate-400">
          Badhu trading data saaf kare chhe: setups, strategies, orders, audit log · capital पाछું ₹10,000 default · users ane instruments rahe chhe. Aa pachhu laavi shakatu nathi!
        </div>
        <label className="flex items-center gap-2 text-xs" id="fr-keep-brokers">
          <input type="checkbox" defaultChecked /> Broker accounts rakhva (API keys saathe)
        </label>
        <button
          className="btn btn-red"
          onClick={() => {
            const keep = (document.querySelector("#fr-keep-brokers input") as HTMLInputElement)?.checked ?? true;
            const typed = prompt('Fresh app karva mate "RESET" lakho (badhu trading data delete thashe):');
            if (typed !== "RESET") return;
            void run(post("/api/admin", { action: "factory-reset", confirm: "RESET", keepBrokers: keep }), () => setTimeout(() => window.location.reload(), 1200));
          }}
        >
          🗑 Factory Reset — Fresh App
        </button>
      </div>
    </div>
  );
}
