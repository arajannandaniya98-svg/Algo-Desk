import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/db";
import { audit } from "@/lib/security/audit";
import { ensureSetupCode, userCount } from "@/lib/security/bootstrap";
import { dummyVerify, hashPassword, passwordProblems, verifyPassword } from "@/lib/security/password";
import { rateLimit, rateReset } from "@/lib/security/rate-limit";
import { open } from "@/lib/security/secrets";
import {
  clientIp,
  createSession,
  forgetSessionCache,
  getSecurityConfig,
  lookupSession,
  revokeSessionToken,
  SESSION_COOKIE,
  sessionCookie,
  sha256,
  type SecurityConfig,
} from "@/lib/security/session";
import { verifyTotp } from "@/lib/security/totp";
import { randomInt } from "crypto";
import { maskEmail, sendOtpEmail } from "@/lib/security/email";
import { maskMobile, sendOtpSms } from "@/lib/security/sms";

export const dynamic = "force-dynamic";
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const GENERIC = "Invalid username or password";

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

let defaultCredsCache: { v: boolean; at: number } | null = null;
async function isDefaultAdminPassword(): Promise<boolean> {
  if (defaultCredsCache && Date.now() - defaultCredsCache.at < 60_000) return defaultCredsCache.v;
  let v = false;
  const r = await pool.query("select password_hash from users where username = 'admin' and must_change_password = true and is_active = true limit 1");
  if (r.rows[0]) v = await verifyPassword("admin", r.rows[0].password_hash);
  defaultCredsCache = { v, at: Date.now() };
  return v;
}

/** GET — first-run state + current login */
export async function GET(req: NextRequest) {
  if ((await userCount()) === 0) {
    await ensureSetupCode();
    return NextResponse.json({ needsSetup: true, authenticated: false, user: null });
  }
  // hint shown on the login page only while the password is literally still "admin"
  const defaultCreds = await isDefaultAdminPassword();
  const u = await lookupSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({
    needsSetup: false,
    defaultCreds,
    authenticated: !!u,
    user: u ? { username: u.username, displayName: u.displayName, role: u.role, mustChangePassword: u.mustChangePassword, totpEnabled: u.totpEnabled } : null,
  });
}

type UserRow = { id: number; username: string; role: string; is_active: boolean; password_hash: string; failed_attempts: number; locked_until: Date | null; totp_enabled: boolean; totp_secret: string; totp_last_counter: number; must_change_password: boolean; email: string; mobile: string; login_otp_channel: string; login_otp_hash: string; login_otp_expires: Date | null; login_otp_attempts: number };

async function registerFailure(u: UserRow, cfg: SecurityConfig, ip: string, ua: string, reason: string) {
  const attempts = (u.failed_attempts ?? 0) + 1;
  const lock = attempts >= cfg.maxLoginAttempts;
  await pool.query(
    "update users set failed_attempts = $1, locked_until = case when $2::boolean then now() + make_interval(mins => $3::int) else locked_until end, updated_at = now() where id = $4",
    [lock ? 0 : attempts, lock, cfg.lockoutMinutes, u.id],
  );
  audit({ userId: u.id, username: u.username, action: lock ? "ACCOUNT_LOCKED" : "LOGIN_FAILED", detail: `${reason} (attempt ${attempts}/${cfg.maxLoginAttempts})`, ip, userAgent: ua, success: false });
}

/** POST — { action: "login" | "setup", ... } */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 300);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "login");
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  const rl = rateLimit(`auth:${ip}`, 10, 15 * 60_000);
  if (!rl.ok) {
    audit({ username, action: "LOGIN_RATE_LIMITED", ip, userAgent: ua, success: false });
    return NextResponse.json({ ok: false, error: `Too many attempts from your IP. Try again in ${Math.ceil(rl.retryAfterSec / 60)} min.` }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }
  const cfg = await getSecurityConfig(true);

  // ---------- first-run admin creation ----------
  if (action === "setup") {
    if ((await userCount()) > 0) return NextResponse.json({ ok: false, error: "Setup already completed — please login" }, { status: 409 });
    const code = String(body.setupCode ?? "").trim().toUpperCase();
    const row = (await pool.query("select setup_code_hash, setup_code_expires from security_settings where id = 1")).rows[0];
    const valid = !!row?.setup_code_hash && !!row.setup_code_expires && new Date(row.setup_code_expires) > new Date() && safeEq(sha256(code), row.setup_code_hash);
    if (!valid) {
      audit({ action: "SETUP_CODE_INVALID", ip, userAgent: ua, success: false });
      return NextResponse.json({ ok: false, error: "Invalid or expired setup code — copy it from the server console window" }, { status: 401 });
    }
    if (!USERNAME_RE.test(username)) return NextResponse.json({ ok: false, error: "Username: 3-32 characters, a-z 0-9 . _ -" }, { status: 400 });
    const problem = passwordProblems(password, cfg.passwordMinLength, username);
    if (problem) return NextResponse.json({ ok: false, error: problem }, { status: 400 });
    const displayName = String(body.displayName ?? "").trim().slice(0, 60) || "Administrator";
    const ins = await pool.query(
      "insert into users (username, display_name, password_hash, role) select $1, $2, $3, 'admin' where not exists (select 1 from users) returning id",
      [username, displayName, await hashPassword(password)],
    );
    const id = ins.rows[0]?.id as number | undefined;
    if (!id) return NextResponse.json({ ok: false, error: "Setup already completed — please login" }, { status: 409 });
    await pool.query("update security_settings set setup_code_hash = '', setup_code_expires = null where id = 1");
    rateReset(`auth:${ip}`);
    const s = await createSession(id, ip, ua);
    audit({ userId: id, username, action: "ADMIN_SETUP", detail: "first admin account created", ip, userAgent: ua });
    const res = NextResponse.json({ ok: true, user: { username, role: "admin", mustChangePassword: false } });
    res.cookies.set(sessionCookie(req, s.token, s.maxAgeSec));
    return res;
  }

  // ---------- login ----------
  if (!username || !password || password.length > 256) return NextResponse.json({ ok: false, error: "Username and password required" }, { status: 400 });
  const u = (await pool.query("select * from users where username = $1", [username])).rows[0] as UserRow | undefined;
  if (!u || !u.is_active) {
    await dummyVerify(password);
    audit({ userId: u?.id ?? null, username, action: "LOGIN_FAILED", detail: u ? "account disabled" : "unknown username", ip, userAgent: ua, success: false });
    return NextResponse.json({ ok: false, error: GENERIC }, { status: 401 });
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000));
    audit({ userId: u.id, username, action: "LOGIN_BLOCKED", detail: "account locked", ip, userAgent: ua, success: false });
    return NextResponse.json({ ok: false, error: `Account locked after too many failed attempts. Try again in ${mins} min or ask an admin to unlock it.` }, { status: 423 });
  }
  if (!(await verifyPassword(password, u.password_hash))) {
    await registerFailure(u, cfg, ip, ua, "wrong password");
    return NextResponse.json({ ok: false, error: GENERIC }, { status: 401 });
  }
  if (u.totp_enabled) {
    const totp = String(body.totp ?? "").trim();
    if (!totp) return NextResponse.json({ ok: false, need2fa: true, error: "Enter the 6-digit code from your authenticator app" });
    const ctr = verifyTotp(open(u.totp_secret), totp, u.totp_last_counter);
    if (ctr == null) {
      await registerFailure(u, cfg, ip, ua, "wrong 2FA code");
      return NextResponse.json({ ok: false, need2fa: true, error: "Invalid or already used 2FA code" }, { status: 401 });
    }
    await pool.query("update users set totp_last_counter = $1 where id = $2", [ctr, u.id]);
  }

  // ---- login confirmation OTP via email / mobile / both (if the user enabled it) ----
  const channel = u.login_otp_channel || "none";
  if (channel !== "none") {
    const destinations: string[] = [];
    if ((channel === "email" || channel === "both") && u.email) destinations.push(`email ${maskEmail(u.email)}`);
    if ((channel === "mobile" || channel === "both") && u.mobile) destinations.push(`mobile ${maskMobile(u.mobile)}`);
    const loginOtp = String(body.loginOtp ?? "").replace(/\D/g, "");
    if (!loginOtp) {
      const fresh = u.login_otp_hash && u.login_otp_expires && new Date(u.login_otp_expires) > new Date();
      const cd = rateLimit(`login-otp:${u.id}`, 1, 60_000);
      if (!fresh || cd.ok) {
        const otp = String(randomInt(100000, 1000000));
        await pool.query("update users set login_otp_hash = $1, login_otp_expires = now() + interval '10 minutes', login_otp_attempts = 0 where id = $2", [sha256(`login:${u.id}:${otp}`), u.id]);
        const sends: string[] = [];
        if ((channel === "email" || channel === "both") && u.email) sends.push((await sendOtpEmail(u.email, otp, "login confirmation")).message);
        if ((channel === "mobile" || channel === "both") && u.mobile) sends.push((await sendOtpSms(u.mobile, otp)).message);
        audit({ userId: u.id, username, action: "LOGIN_OTP_SENT", detail: `${channel}: ${sends.join(" · ")}`.slice(0, 300), ip, userAgent: ua });
      }
      return NextResponse.json({ ok: false, needLoginOtp: true, sentTo: destinations, error: `Confirmation OTP sent to ${destinations.join(" + ") || "configured channel"}` });
    }
    const valid = u.login_otp_hash && u.login_otp_expires && new Date(u.login_otp_expires) > new Date() && u.login_otp_attempts < 5 && sha256(`login:${u.id}:${loginOtp}`) === u.login_otp_hash;
    if (!valid) {
      await pool.query("update users set login_otp_attempts = login_otp_attempts + 1 where id = $1", [u.id]);
      audit({ userId: u.id, username, action: "LOGIN_OTP_WRONG", ip, userAgent: ua, success: false });
      return NextResponse.json({ ok: false, needLoginOtp: true, sentTo: destinations, error: "Wrong or expired OTP — try again or press Resend" }, { status: 401 });
    }
    await pool.query("update users set login_otp_hash = '', login_otp_expires = null, login_otp_attempts = 0 where id = $1", [u.id]);
  }

  defaultCredsCache = null;
  await pool.query("update users set failed_attempts = 0, locked_until = null, last_login_at = now(), last_login_ip = $1, updated_at = now() where id = $2", [ip, u.id]);
  rateReset(`auth:${ip}`);
  const s = await createSession(u.id, ip, ua);
  audit({ userId: u.id, username: u.username, action: "LOGIN_SUCCESS", detail: [u.totp_enabled ? "2FA" : null, channel !== "none" ? `OTP(${channel})` : null].filter(Boolean).join(" + ") || "password only", ip, userAgent: ua });
  const res = NextResponse.json({ ok: true, user: { username: u.username, role: u.role, mustChangePassword: u.must_change_password } });
  res.cookies.set(sessionCookie(req, s.token, s.maxAgeSec));
  return res;
}

/** DELETE — logout (revokes the session server-side) */
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const u = await lookupSession(token).catch(() => null);
  if (token) await revokeSessionToken(token).catch(() => {});
  forgetSessionCache();
  if (u) audit({ userId: u.userId, username: u.username, action: "LOGOUT", ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") ?? "" });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(req, "", 0));
  return res;
}
