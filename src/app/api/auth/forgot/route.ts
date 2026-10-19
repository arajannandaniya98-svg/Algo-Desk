import { randomInt } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/db";
import { audit } from "@/lib/security/audit";
import { hashPassword, passwordProblems } from "@/lib/security/password";
import { rateLimit } from "@/lib/security/rate-limit";
import { clientIp, forgetSessionCache, getSecurityConfig, sha256 } from "@/lib/security/session";
import { maskMobile, sendOtpSms, smsProvider } from "@/lib/security/sms";

export const dynamic = "force-dynamic";

const GENERIC = "If the username and mobile match, an OTP has been sent.";
type UserRow = { id: number; username: string; mobile: string; is_active: boolean; reset_otp_hash: string; reset_otp_expires: Date | null; reset_otp_attempts: number };

/** GET — which SMS provider is active (login page hint) */
export async function GET() {
  return NextResponse.json({ provider: smsProvider() });
}

/**
 * POST { action: "send", username, mobileLast4? }  → sends 6-digit OTP to the registered mobile
 * POST { action: "verify", username, otp, newPassword } → resets the password
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 300);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "send");
  const username = String(body.username ?? "").trim().toLowerCase();
  if (!username) return NextResponse.json({ ok: false, error: "Username required" }, { status: 400 });

  const rl = rateLimit(`forgot:${ip}`, 8, 15 * 60_000);
  if (!rl.ok) return NextResponse.json({ ok: false, error: `Too many attempts. Try again in ${Math.ceil(rl.retryAfterSec / 60)} min.` }, { status: 429 });

  const u = (await pool.query("select id, username, mobile, is_active, reset_otp_hash, reset_otp_expires, reset_otp_attempts from users where username = $1", [username])).rows[0] as
    | UserRow
    | undefined;

  if (action === "send") {
    // per-user cooldown: one OTP per 60s
    if (u?.is_active && u.mobile) {
      const cd = rateLimit(`forgot-user:${u.id}`, 1, 60_000);
      if (!cd.ok) return NextResponse.json({ ok: false, error: `Wait ${cd.retryAfterSec}s before requesting another OTP` }, { status: 429 });
      const otp = String(randomInt(100000, 1000000));
      await pool.query("update users set reset_otp_hash = $1, reset_otp_expires = now() + interval '10 minutes', reset_otp_attempts = 0 where id = $2", [sha256(`${u.id}:${otp}`), u.id]);
      const sent = await sendOtpSms(u.mobile, otp);
      audit({ userId: u.id, username, action: "RESET_OTP_SENT", detail: `${sent.provider}: ${sent.message}`, ip, userAgent: ua, success: sent.ok });
      if (!sent.ok) return NextResponse.json({ ok: false, error: sent.message }, { status: 502 });
      return NextResponse.json({ ok: true, message: `OTP sent to ${maskMobile(u.mobile)} — valid 10 minutes`, mobileMasked: maskMobile(u.mobile), provider: sent.provider });
    }
    audit({ username, action: "RESET_OTP_SENT", detail: u ? (u.mobile ? "inactive account" : "no mobile on file") : "unknown username", ip, userAgent: ua, success: false });
    // Same generic reply → usernames/mobiles can't be probed. Console hint for owners without mobile set:
    if (u && !u.mobile) console.log(`[AlgoDesk] Password reset requested for "${username}" but no mobile is set. Use: node scripts/admin-cli.mjs reset-password ${username} "New#Pass2026"`);
    return NextResponse.json({ ok: true, message: GENERIC, mobileMasked: null });
  }

  if (action === "verify") {
    const otp = String(body.otp ?? "").replace(/\D/g, "");
    const newPassword = String(body.newPassword ?? "");
    if (!u || !u.is_active || !u.reset_otp_hash || !u.reset_otp_expires) return NextResponse.json({ ok: false, error: "Request a new OTP first" }, { status: 400 });
    if (new Date(u.reset_otp_expires) < new Date()) return NextResponse.json({ ok: false, error: "OTP expired — request a new one" }, { status: 400 });
    if (u.reset_otp_attempts >= 5) {
      await pool.query("update users set reset_otp_hash = '', reset_otp_expires = null where id = $1", [u.id]);
      audit({ userId: u.id, username, action: "RESET_OTP_BLOCKED", detail: "too many wrong OTPs", ip, userAgent: ua, success: false });
      return NextResponse.json({ ok: false, error: "Too many wrong OTPs — request a new one" }, { status: 429 });
    }
    if (sha256(`${u.id}:${otp}`) !== u.reset_otp_hash) {
      await pool.query("update users set reset_otp_attempts = reset_otp_attempts + 1 where id = $1", [u.id]);
      audit({ userId: u.id, username, action: "RESET_OTP_WRONG", ip, userAgent: ua, success: false });
      return NextResponse.json({ ok: false, error: `Wrong OTP (${4 - u.reset_otp_attempts} tries left)` }, { status: 401 });
    }
    const cfg = await getSecurityConfig();
    const problem = passwordProblems(newPassword, cfg.passwordMinLength, username);
    if (problem) return NextResponse.json({ ok: false, error: problem }, { status: 400 });
    await pool.query(
      "update users set password_hash = $1, must_change_password = false, failed_attempts = 0, locked_until = null, reset_otp_hash = '', reset_otp_expires = null, reset_otp_attempts = 0, password_changed_at = now(), updated_at = now() where id = $2",
      [await hashPassword(newPassword), u.id],
    );
    await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [u.id]);
    forgetSessionCache();
    audit({ userId: u.id, username, action: "PASSWORD_RESET_OTP", detail: "via mobile OTP, all sessions signed out", ip, userAgent: ua });
    return NextResponse.json({ ok: true, message: "Password reset ✓ — login with the new password" });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}
