import QRCode from "qrcode";
import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/db";
import { actor, audit } from "@/lib/security/audit";
import { passwordProblems, hashPassword, verifyPassword } from "@/lib/security/password";
import { open, seal } from "@/lib/security/secrets";
import { forgetSessionCache, getSecurityConfig } from "@/lib/security/session";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/security/totp";
import { maskMobile, normalizeMobile } from "@/lib/security/sms";
import { isValidEmail, maskEmail } from "@/lib/security/email";

export const dynamic = "force-dynamic";
const err = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** GET — my profile, sessions and password policy */
export async function GET(req: NextRequest) {
  const me = actor(req.headers);
  if (!me.userId) return err("Login required", 401);
  const [u, s, cfg] = await Promise.all([
    pool.query(
      "select id, username, display_name, role, totp_enabled, must_change_password, last_login_at, last_login_ip, password_changed_at, created_at, mobile, email, login_otp_channel from users where id = $1",
      [me.userId],
    ),
    pool.query(
      "select id, ip, user_agent, created_at, last_seen_at, expires_at from sessions where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc",
      [me.userId],
    ),
    getSecurityConfig(),
  ]);
  const user = u.rows[0];
  if (!user) return err("User not found", 404);
  return NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      totpEnabled: user.totp_enabled,
      mustChangePassword: user.must_change_password,
      lastLoginAt: user.last_login_at,
      lastLoginIp: user.last_login_ip,
      passwordChangedAt: user.password_changed_at,
      createdAt: user.created_at,
      mobileMasked: user.mobile ? maskMobile(user.mobile) : "",
      hasMobile: !!user.mobile,
      emailMasked: user.email ? maskEmail(user.email) : "",
      hasEmail: !!user.email,
      loginOtpChannel: user.login_otp_channel || "none",
    },
    sessions: s.rows.map((r) => ({ id: r.id, ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, current: r.id === me.sessionId })),
    policy: { passwordMinLength: cfg.passwordMinLength, require2faAdmin: cfg.require2faAdmin, sessionIdleMinutes: cfg.sessionIdleMinutes, sessionMaxHours: cfg.sessionMaxHours },
    needs2fa: cfg.require2faAdmin && user.role === "admin" && !user.totp_enabled,
  });
}

/** POST — change-password | 2fa-init | 2fa-enable | 2fa-disable | revoke-session | logout-others | profile */
export async function POST(req: NextRequest) {
  const me = actor(req.headers);
  if (!me.userId) return err("Login required", 401);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const row = (await pool.query("select * from users where id = $1", [me.userId])).rows[0];
  if (!row) return err("User not found", 404);
  const log = (action: string, detail = "", success = true) => audit({ userId: me.userId, username: me.username, action, detail, ip: me.ip, userAgent: me.userAgent, success });

  switch (String(body.action)) {
    case "change-password": {
      const current = String(body.currentPassword ?? "");
      const next = String(body.newPassword ?? "");
      if (!(await verifyPassword(current, row.password_hash))) {
        log("PASSWORD_CHANGE_FAILED", "wrong current password", false);
        return err("Current password is wrong", 401);
      }
      const cfg = await getSecurityConfig();
      const problem = passwordProblems(next, cfg.passwordMinLength, row.username);
      if (problem) return err(problem);
      if (await verifyPassword(next, row.password_hash)) return err("New password must be different from the current one");
      await pool.query("update users set password_hash = $1, must_change_password = false, password_changed_at = now(), updated_at = now() where id = $2", [await hashPassword(next), me.userId]);
      await pool.query("update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null", [me.userId, me.sessionId ?? 0]);
      forgetSessionCache();
      log("PASSWORD_CHANGED", "other sessions signed out");
      return NextResponse.json({ ok: true, message: "Password changed — other devices were signed out" });
    }
    case "2fa-init": {
      if (row.totp_enabled) return err("2FA is already enabled — disable it first to re-enrol");
      const secret = generateTotpSecret();
      await pool.query("update users set totp_secret = $1, totp_last_counter = 0, updated_at = now() where id = $2", [seal(secret), me.userId]);
      const uri = otpauthUri(secret, row.username);
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: "#0b0f17", light: "#ffffff" } });
      log("2FA_ENROLL_STARTED");
      return NextResponse.json({ ok: true, secret, uri, qr });
    }
    case "2fa-enable": {
      const secret = open(row.totp_secret);
      if (!secret) return err("Start 2FA setup first");
      const ctr = verifyTotp(secret, String(body.code ?? ""), row.totp_last_counter);
      if (ctr == null) {
        log("2FA_ENABLE_FAILED", "wrong code", false);
        return err("Wrong code — check the phone clock and try the next code");
      }
      await pool.query("update users set totp_enabled = true, totp_last_counter = $1, updated_at = now() where id = $2", [ctr, me.userId]);
      forgetSessionCache();
      log("2FA_ENABLED");
      return NextResponse.json({ ok: true, message: "Two-factor authentication enabled ✓" });
    }
    case "2fa-disable": {
      if (!row.totp_enabled) return err("2FA is not enabled");
      if (!(await verifyPassword(String(body.password ?? ""), row.password_hash))) {
        log("2FA_DISABLE_FAILED", "wrong password", false);
        return err("Wrong password", 401);
      }
      const ctr = verifyTotp(open(row.totp_secret), String(body.code ?? ""), row.totp_last_counter);
      if (ctr == null) {
        log("2FA_DISABLE_FAILED", "wrong code", false);
        return err("Wrong 2FA code", 401);
      }
      await pool.query("update users set totp_enabled = false, totp_secret = '', totp_last_counter = 0, updated_at = now() where id = $1", [me.userId]);
      forgetSessionCache();
      log("2FA_DISABLED");
      return NextResponse.json({ ok: true, message: "2FA disabled" });
    }
    case "revoke-session": {
      await pool.query("update sessions set revoked_at = now() where id = $1 and user_id = $2", [Number(body.id), me.userId]);
      forgetSessionCache();
      log("SESSION_REVOKED", `session #${Number(body.id)}`);
      return NextResponse.json({ ok: true, message: "Session signed out" });
    }
    case "logout-others": {
      const r = await pool.query("update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null", [me.userId, me.sessionId ?? 0]);
      forgetSessionCache();
      log("SESSIONS_REVOKED", `${r.rowCount} other session(s)`);
      return NextResponse.json({ ok: true, message: `${r.rowCount} other session(s) signed out` });
    }
    case "profile": {
      const displayName = String(body.displayName ?? "").trim().slice(0, 60);
      await pool.query("update users set display_name = $1, updated_at = now() where id = $2", [displayName, me.userId]);
      forgetSessionCache();
      return NextResponse.json({ ok: true, message: "Profile saved" });
    }
    case "set-email": {
      if (!(await verifyPassword(String(body.password ?? ""), row.password_hash))) {
        log("EMAIL_CHANGE_FAILED", "wrong password", false);
        return err("Wrong password", 401);
      }
      const raw = String(body.email ?? "").trim().toLowerCase();
      if (raw === "") {
        await pool.query("update users set email = '', login_otp_channel = case when login_otp_channel in ('email','both') then 'none' else login_otp_channel end, updated_at = now() where id = $1", [me.userId]);
        forgetSessionCache();
        log("EMAIL_REMOVED");
        return NextResponse.json({ ok: true, message: "Email removed" });
      }
      if (!isValidEmail(raw)) return err("Enter a valid email (e.g. you@gmail.com)");
      await pool.query("update users set email = $1, updated_at = now() where id = $2", [raw, me.userId]);
      log("EMAIL_SET", maskEmail(raw));
      return NextResponse.json({ ok: true, message: `Email saved (${maskEmail(raw)})` });
    }
    case "login-otp-channel": {
      if (!(await verifyPassword(String(body.password ?? ""), row.password_hash))) {
        log("LOGIN_OTP_CHANNEL_FAILED", "wrong password", false);
        return err("Wrong password", 401);
      }
      const channel = String(body.channel ?? "none");
      if (!["none", "email", "mobile", "both"].includes(channel)) return err("Invalid channel");
      if ((channel === "email" || channel === "both") && !row.email) return err("Save your email first");
      if ((channel === "mobile" || channel === "both") && !row.mobile) return err("Save your mobile first");
      await pool.query("update users set login_otp_channel = $1, login_otp_hash = '', login_otp_expires = null, updated_at = now() where id = $2", [channel, me.userId]);
      forgetSessionCache();
      log("LOGIN_OTP_CHANNEL", channel);
      return NextResponse.json({ ok: true, message: channel === "none" ? "Login OTP confirmation disabled" : `Login OTP via ${channel} enabled — every login will need the code` });
    }
    case "set-mobile": {
      if (!(await verifyPassword(String(body.password ?? ""), row.password_hash))) {
        log("MOBILE_CHANGE_FAILED", "wrong password", false);
        return err("Wrong password", 401);
      }
      const raw = String(body.mobile ?? "").trim();
      if (raw === "") {
        await pool.query("update users set mobile = '', updated_at = now() where id = $1", [me.userId]);
        log("MOBILE_REMOVED");
        return NextResponse.json({ ok: true, message: "Mobile removed — OTP password reset disabled" });
      }
      const m = normalizeMobile(raw);
      if (!m) return err("Enter a valid Indian mobile (10 digits, starts 6-9)");
      await pool.query("update users set mobile = $1, updated_at = now() where id = $2", [m, me.userId]);
      log("MOBILE_SET", maskMobile(m));
      return NextResponse.json({ ok: true, message: `Mobile saved (${maskMobile(m)}) — OTP password reset enabled` });
    }
    default:
      return err("Unknown action");
  }
}
