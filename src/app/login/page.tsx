"use client";

import { useEffect, useState, type FormEvent } from "react";

type Mode = "loading" | "setup" | "login" | "forgot";

function strength(pw: string) {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}
const STRENGTH = [
  { label: "Very weak", cls: "bg-red-600" },
  { label: "Weak", cls: "bg-red-500" },
  { label: "Fair", cls: "bg-amber-500" },
  { label: "Good", cls: "bg-lime-500" },
  { label: "Strong", cls: "bg-emerald-500" },
];

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [totp, setTotp] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpInfo, setOtpInfo] = useState("");
  const [loginOtp, setLoginOtp] = useState("");
  const [needLoginOtp, setNeedLoginOtp] = useState(false);
  const [loginOtpInfo, setLoginOtpInfo] = useState("");
  const [defaultCreds, setDefaultCreds] = useState(false);
  const [need2fa, setNeed2fa] = useState(false);
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const go = (mustChange?: boolean) => {
    const next = new URLSearchParams(window.location.search).get("next") || "/";
    window.location.href = mustChange ? "/admin?tab=account" : next.startsWith("/") && !next.startsWith("//") ? next : "/";
  };

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((j: { needsSetup?: boolean; authenticated?: boolean; defaultCreds?: boolean; user?: { mustChangePassword?: boolean } }) => {
        if (j.authenticated) return go(j.user?.mustChangePassword);
        setDefaultCreds(!!j.defaultCreds);
        setMode(j.needsSetup ? "setup" : "login");
      })
      .catch(() => setMode("login"));
  }, []);

  const sendOtp = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/auth/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", username }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string; mobileMasked?: string | null };
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not send OTP");
      setOtpSent(true);
      setOtpInfo(j.message || "OTP sent");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) return setError("Passwords do not match");
    setBusy(true);
    try {
      const r = await fetch("/api/auth/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", username, otp, newPassword: password }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error || "Reset failed");
      setMode("login");
      setOtpSent(false);
      setOtp("");
      setPassword("");
      setConfirm("");
      setOtpInfo("");
      setError("");
      alert(j.message || "Password reset — login now");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (mode === "setup" && password !== confirm) return setError("Passwords do not match");
    setBusy(true);
    try {
      const body =
        mode === "setup"
          ? { action: "setup", setupCode, username, password, displayName }
          : { action: "login", username, password, totp: need2fa ? totp : undefined, loginOtp: needLoginOtp && loginOtp ? loginOtp : undefined };
      const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; need2fa?: boolean; needLoginOtp?: boolean; sentTo?: string[]; error?: string; user?: { mustChangePassword?: boolean } };
      if (j.needLoginOtp) {
        setNeedLoginOtp(true);
        setLoginOtpInfo((j.sentTo ?? []).join(" + "));
        if (r.status === 401) setError(j.error || "Wrong OTP");
        else setError("");
        setLoginOtp("");
        setBusy(false);
        return;
      }
      if (j.need2fa) {
        setNeed2fa(true);
        if (r.status !== 200) setError(j.error || "Invalid 2FA code");
        setTotp("");
        setBusy(false);
        return;
      }
      if (!r.ok || !j.ok) throw new Error(j.error || "Login failed");
      go(j.user?.mustChangePassword);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const sc = strength(password);

  return (
    <div className="min-h-[88vh] flex items-center justify-center">
      <form onSubmit={submit} className="panel w-full max-w-sm p-6 space-y-4" autoComplete="on">
        <div className="text-center">
          <div className="text-2xl font-black tracking-tight">
            <span className="text-sky-400">Algo</span>Desk <span className="text-xs font-semibold text-slate-400 align-top">IN</span>
          </div>
          <div className="text-xs text-slate-400 mt-1">{mode === "setup" ? "🛡 First-run setup — create the Admin account" : "🔒 Secure login"}</div>
        </div>

        {mode === "loading" && <div className="text-center text-xs text-slate-500 py-6">Checking…</div>}

        {mode === "setup" && (
          <>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-100 leading-relaxed">
              Server ni <b>black window / terminal / pm2 logs</b> ma <b>FIRST-RUN SETUP CODE</b> chhapayo chhe (e.g. <span className="mono">K7QM-2XPA</span>). Te code ahi lakho. Aa code vagar koi bijo admin nahi bani shake.
            </div>
            <div>
              <label className="label">Setup Code</label>
              <input className="input mono uppercase tracking-widest" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} placeholder="XXXX-XXXX" autoFocus />
            </div>
            <div>
              <label className="label">Display Name</label>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Owner" />
            </div>
          </>
        )}

        {mode === "login" && defaultCreds && !needLoginOtp && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-[11px] text-sky-100 leading-relaxed">
            🔑 <b>Default login:</b> username <span className="mono font-bold">admin</span> · password <span className="mono font-bold">admin</span>
            <br />Login thata j navo strong password set karvo padshe.
          </div>
        )}
        {mode !== "loading" && mode !== "forgot" && (
          <>
            <div>
              <label className="label">Username</label>
              <input className="input mono" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" autoFocus={mode === "login"} disabled={need2fa} placeholder="admin" />
            </div>
            <div>
              <label className="label">Password</label>
              <div className="flex gap-1">
                <input
                  className="input mono"
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "setup" ? "new-password" : "current-password"}
                  disabled={need2fa}
                />
                <button type="button" className="btn btn-xs" onClick={() => setShow(!show)}>
                  {show ? "Hide" : "Show"}
                </button>
              </div>
              {mode === "setup" && password && (
                <div className="mt-1.5">
                  <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className={`h-full ${STRENGTH[sc].cls}`} style={{ width: `${((sc + 1) / 5) * 100}%` }} />
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{STRENGTH[sc].label} · min 10 chars, letters + numbers + UPPER/symbol</div>
                </div>
              )}
            </div>
            {mode === "setup" && (
              <div>
                <label className="label">Confirm Password</label>
                <input className="input mono" type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </div>
            )}
            {needLoginOtp && (
              <div>
                <label className="label">Login OTP {loginOtpInfo && <span className="normal-case text-emerald-400">→ {loginOtpInfo}</span>}</label>
                <input
                  className="input mono text-center text-lg tracking-[0.5em]"
                  inputMode="numeric"
                  maxLength={6}
                  value={loginOtp}
                  onChange={(e) => setLoginOtp(e.target.value.replace(/\D/g, ""))}
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="000000"
                />
                <button type="button" className="btn btn-xs w-full mt-1" disabled={busy} onClick={(e) => { setLoginOtp(""); submit(e as unknown as FormEvent); }}>
                  ↻ Resend OTP
                </button>
              </div>
            )}
            {need2fa && (
              <div>
                <label className="label">2FA Code (Authenticator app)</label>
                <input
                  className="input mono text-center text-lg tracking-[0.5em]"
                  inputMode="numeric"
                  maxLength={6}
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="000000"
                />
              </div>
            )}
          </>
        )}

        {mode === "forgot" && (
          <div className="space-y-3">
            <div>
              <label className="label">Username</label>
              <input className="input mono" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="admin" autoFocus={!otpSent} disabled={otpSent} />
            </div>
            {!otpSent ? (
              <>
                <div className="text-[11px] text-slate-400 leading-relaxed">Registered mobile par 6-digit OTP aavshe (My Account ma mobile save karelo hovo joiye). SMS provider set na hoy to OTP server ni console window ma chhapay chhe.</div>
                <button type="button" className="btn btn-primary w-full" disabled={busy || !username} onClick={sendOtp}>
                  {busy ? "Sending…" : "📲 Send OTP"}
                </button>
              </>
            ) : (
              <>
                {otpInfo && <div className="text-xs rounded bg-emerald-500/15 text-emerald-300 px-3 py-2">{otpInfo}</div>}
                <div>
                  <label className="label">6-digit OTP</label>
                  <input className="input mono text-center text-lg tracking-[0.5em]" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} placeholder="000000" autoFocus />
                </div>
                <div>
                  <label className="label">New Password</label>
                  <input className="input mono" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                </div>
                <div>
                  <label className="label">Confirm New Password</label>
                  <input className="input mono" type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                </div>
                <button type="button" className="btn btn-primary w-full" disabled={busy || otp.length !== 6 || !password} onClick={(e) => verifyOtp(e as unknown as FormEvent)}>
                  {busy ? "Resetting…" : "Reset Password →"}
                </button>
                <button type="button" className="btn btn-xs w-full" disabled={busy} onClick={sendOtp}>
                  ↻ Resend OTP
                </button>
              </>
            )}
            <button type="button" className="btn btn-xs w-full" onClick={() => { setMode("login"); setOtpSent(false); setOtp(""); setError(""); }}>
              ← Back to login
            </button>
          </div>
        )}

        {error && <div className="text-xs rounded bg-red-500/15 text-red-300 px-3 py-2">{error}</div>}

        {mode === "login" && !need2fa && (
          <button type="button" className="w-full text-center text-[11px] text-sky-400 hover:underline" onClick={() => { setMode("forgot"); setError(""); setPassword(""); }}>
            Forgot password? (Mobile OTP)
          </button>
        )}
        {mode !== "loading" && mode !== "forgot" && (
          <button className="btn btn-primary w-full" disabled={busy || !username || !password || (mode === "setup" && !setupCode) || (need2fa && totp.length !== 6) || (needLoginOtp && loginOtp.length !== 6)}>
            {busy ? "Checking…" : mode === "setup" ? "Create Admin & Login →" : needLoginOtp ? "Verify OTP →" : need2fa ? "Verify 2FA →" : "Login →"}
          </button>
        )}
        {need2fa && (
          <button
            type="button"
            className="btn btn-xs w-full"
            onClick={() => {
              setNeed2fa(false);
              setTotp("");
              setError("");
            }}
          >
            ← Use a different account
          </button>
        )}
        <p className="text-[10px] text-slate-500 text-center leading-relaxed">
          5 khota prayatno pachhi account 15 min lock thay chhe. Password bhuli gaya? Admin ne kaho athva server par: <span className="mono">node scripts/admin-cli.mjs reset-password &lt;user&gt; &lt;new&gt;</span>
        </p>
      </form>
    </div>
  );
}
