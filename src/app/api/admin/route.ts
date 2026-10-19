import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/db";
import { actor, audit } from "@/lib/security/audit";
import { hashPassword, passwordProblems } from "@/lib/security/password";
import { secretKeySource } from "@/lib/security/secrets";
import { forgetSessionCache, getSecurityConfig, isHttps, ROLES } from "@/lib/security/session";
import { normalizeMobile } from "@/lib/security/sms";
import { isValidEmail } from "@/lib/security/email";

export const dynamic = "force-dynamic";
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const err = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

async function activeAdmins(excludeId?: number): Promise<number> {
  const r = await pool.query("select count(*)::int as n from users where role = 'admin' and is_active = true and id <> $1", [excludeId ?? 0]);
  return Number(r.rows[0]?.n ?? 0);
}

/** GET ?view=overview|users|sessions|audit|security */
export async function GET(req: NextRequest) {
  const me = actor(req.headers);
  if (me.role !== "admin") return err("Admin only", 403);
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view") ?? "overview";

  if (view === "users") {
    const r = await pool.query(
      `select u.id, u.username, u.display_name, u.role, u.is_active, u.must_change_password, u.totp_enabled, u.failed_attempts, u.locked_until,
              u.last_login_at, u.last_login_ip, u.password_changed_at, u.created_at, u.mobile, u.email, u.login_otp_channel,
              (select count(*)::int from sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as sessions
         from users u order by u.id`,
    );
    return NextResponse.json({ items: r.rows, me: me.userId });
  }
  if (view === "sessions") {
    const r = await pool.query(
      `select s.id, s.user_id, u.username, u.role, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at
         from sessions s join users u on u.id = s.user_id
        where s.revoked_at is null and s.expires_at > now() order by s.last_seen_at desc limit 300`,
    );
    return NextResponse.json({ items: r.rows, current: me.sessionId });
  }
  if (view === "audit") {
    const limit = clamp(sp.get("limit"), 10, 2000, 300);
    const q = (sp.get("q") ?? "").trim();
    const success = sp.get("success");
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (q) {
      vals.push(`%${q}%`);
      conds.push(`(action ilike $${vals.length} or username ilike $${vals.length} or detail ilike $${vals.length} or target ilike $${vals.length} or ip ilike $${vals.length})`);
    }
    if (success === "1" || success === "0") {
      vals.push(success === "1");
      conds.push(`success = $${vals.length}`);
    }
    vals.push(limit);
    const r = await pool.query(`select * from audit_logs ${conds.length ? `where ${conds.join(" and ")}` : ""} order by id desc limit $${vals.length}`, vals);
    return NextResponse.json({ items: r.rows });
  }
  if (view === "security") {
    return NextResponse.json({ settings: await getSecurityConfig(true) });
  }

  // overview
  const [counts, cfg] = await Promise.all([
    pool.query(`select
        (select count(*)::int from users) as users,
        (select count(*)::int from users where is_active) as active_users,
        (select count(*)::int from users where role = 'admin' and is_active) as admins,
        (select count(*)::int from users where role = 'admin' and is_active and totp_enabled) as admins_2fa,
        (select count(*)::int from users where is_active and totp_enabled) as users_2fa,
        (select count(*)::int from users where locked_until > now()) as locked,
        (select count(*)::int from users where must_change_password) as must_change,
        (select count(*)::int from sessions where revoked_at is null and expires_at > now()) as sessions,
        (select count(*)::int from audit_logs where success = false and created_at > now() - interval '24 hours') as failed_24h,
        (select count(*)::int from audit_logs where action = 'LOGIN_SUCCESS' and created_at > now() - interval '24 hours') as logins_24h,
        (select count(*)::int from brokers where mode = 'live') as live_brokers`),
    getSecurityConfig(true),
  ]);
  return NextResponse.json({
    counts: counts.rows[0],
    settings: cfg,
    environment: {
      https: isHttps(req),
      appSecret: secretKeySource(),
      envAdminPassword: !!process.env.ADMIN_PASSWORD || !!process.env.APP_PASSWORD,
      nodeEnv: process.env.NODE_ENV ?? "development",
    },
  });
}

/** POST — user management, session revocation, security policy */
export async function POST(req: NextRequest) {
  const me = actor(req.headers);
  if (me.role !== "admin" || !me.userId) return err("Admin only", 403);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const log = (a: string, target = "", detail = "") => audit({ userId: me.userId, username: me.username, action: a, target, detail, ip: me.ip, userAgent: me.userAgent });
  const id = Number(body.id);
  const target = id ? (await pool.query("select id, username, role, is_active from users where id = $1", [id])).rows[0] : null;

  switch (action) {
    case "create-user": {
      const username = String(body.username ?? "").trim().toLowerCase();
      const role = String(body.role ?? "viewer");
      const password = String(body.password ?? "");
      if (!USERNAME_RE.test(username)) return err("Username: 3-32 characters, a-z 0-9 . _ -");
      if (!(ROLES as string[]).includes(role)) return err("Invalid role");
      const cfg = await getSecurityConfig();
      const problem = passwordProblems(password, cfg.passwordMinLength, username);
      if (problem) return err(problem);
      const r = await pool.query(
        "insert into users (username, display_name, password_hash, role, must_change_password) values ($1, $2, $3, $4, $5) on conflict (username) do nothing returning id",
        [username, String(body.displayName ?? "").trim().slice(0, 60), await hashPassword(password), role, body.mustChangePassword !== false],
      );
      if (!r.rows[0]) return err("Username already exists", 409);
      log("USER_CREATED", username, `role ${role}`);
      return NextResponse.json({ ok: true, message: `User ${username} created` });
    }
    case "edit-user": {
      if (!target) return err("User not found", 404);
      const cfg = await getSecurityConfig();
      const sets: string[] = [];
      const vals: unknown[] = [];
      const changes: string[] = [];
      // username rename
      if (body.username !== undefined) {
        const newName = String(body.username).trim().toLowerCase();
        if (newName !== target.username) {
          if (!USERNAME_RE.test(newName)) return err("Username: 3-32 characters, a-z 0-9 . _ -");
          const dup = await pool.query("select 1 from users where username = $1 and id <> $2", [newName, id]);
          if (dup.rows[0]) return err("Username already exists", 409);
          vals.push(newName);
          sets.push(`username = $${vals.length}`);
          changes.push(`username ${target.username} → ${newName}`);
        }
      }
      if (body.displayName !== undefined) {
        vals.push(String(body.displayName).trim().slice(0, 60));
        sets.push(`display_name = $${vals.length}`);
      }
      if (body.mobile !== undefined) {
        const raw = String(body.mobile).trim();
        if (raw === "") {
          sets.push("mobile = ''");
        } else {
          const m = normalizeMobile(raw);
          if (!m) return err("Enter a valid Indian mobile (10 digits, starts 6-9)");
          vals.push(m);
          sets.push(`mobile = $${vals.length}`);
        }
        changes.push("mobile updated");
      }
      if (body.email !== undefined) {
        const raw = String(body.email).trim().toLowerCase();
        if (raw !== "" && !isValidEmail(raw)) return err("Enter a valid email");
        vals.push(raw);
        sets.push(`email = $${vals.length}`);
        changes.push("email updated");
      }
      // optional new password
      const newPw = String(body.newPassword ?? "");
      if (newPw) {
        const problem = passwordProblems(newPw, cfg.passwordMinLength, String(body.username ?? target.username));
        if (problem) return err(problem);
        vals.push(await hashPassword(newPw));
        sets.push(`password_hash = $${vals.length}`);
        vals.push(body.mustChangePassword !== false);
        sets.push(`must_change_password = $${vals.length}`);
        sets.push("failed_attempts = 0", "locked_until = null", "password_changed_at = now()");
        changes.push("password set by admin");
      }
      if (!sets.length) return NextResponse.json({ ok: true, message: "Nothing to change" });
      vals.push(id);
      await pool.query(`update users set ${sets.join(", ")}, updated_at = now() where id = $${vals.length}`, vals);
      if (newPw) await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and id <> $2", [id, id === me.userId ? me.sessionId ?? 0 : 0]);
      forgetSessionCache();
      log("USER_EDITED", target.username, changes.join(", ") || "profile fields");
      return NextResponse.json({ ok: true, message: `Saved${newPw ? " — password changed, user's sessions signed out" : ""}` });
    }
    case "update-user": {
      if (!target) return err("User not found", 404);
      const role = body.role !== undefined ? String(body.role) : target.role;
      const isActive = body.isActive !== undefined ? !!body.isActive : target.is_active;
      if (!(ROLES as string[]).includes(role)) return err("Invalid role");
      if (id === me.userId && (role !== "admin" || !isActive)) return err("You cannot demote or disable your own account");
      if (target.role === "admin" && (role !== "admin" || !isActive) && (await activeAdmins(id)) === 0) return err("At least one active admin is required");
      await pool.query("update users set role = $1, is_active = $2, display_name = coalesce($3, display_name), updated_at = now() where id = $4", [
        role,
        isActive,
        body.displayName !== undefined ? String(body.displayName).slice(0, 60) : null,
        id,
      ]);
      if (!isActive) await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [id]);
      forgetSessionCache();
      log("USER_UPDATED", target.username, `role ${role}, ${isActive ? "active" : "disabled"}`);
      return NextResponse.json({ ok: true, message: "User updated" });
    }
    case "reset-password": {
      if (!target) return err("User not found", 404);
      const cfg = await getSecurityConfig();
      const password = String(body.password ?? "");
      const problem = passwordProblems(password, cfg.passwordMinLength, target.username);
      if (problem) return err(problem);
      await pool.query(
        "update users set password_hash = $1, must_change_password = $2, failed_attempts = 0, locked_until = null, password_changed_at = now(), updated_at = now() where id = $3",
        [await hashPassword(password), body.mustChangePassword !== false, id],
      );
      await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [id]);
      forgetSessionCache();
      log("PASSWORD_RESET", target.username, "all sessions signed out");
      return NextResponse.json({ ok: true, message: `Password reset for ${target.username}` });
    }
    case "unlock": {
      if (!target) return err("User not found", 404);
      await pool.query("update users set failed_attempts = 0, locked_until = null, updated_at = now() where id = $1", [id]);
      log("USER_UNLOCKED", target.username);
      return NextResponse.json({ ok: true, message: `${target.username} unlocked` });
    }
    case "disable-2fa": {
      if (!target) return err("User not found", 404);
      await pool.query("update users set totp_enabled = false, totp_secret = '', totp_last_counter = 0, updated_at = now() where id = $1", [id]);
      forgetSessionCache();
      log("2FA_RESET_BY_ADMIN", target.username);
      return NextResponse.json({ ok: true, message: `2FA removed for ${target.username}` });
    }
    case "logout-user": {
      if (!target) return err("User not found", 404);
      const r = await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and id <> $2", [id, me.sessionId ?? 0]);
      forgetSessionCache();
      log("USER_SIGNED_OUT", target.username, `${r.rowCount} session(s)`);
      return NextResponse.json({ ok: true, message: `${r.rowCount} session(s) signed out` });
    }
    case "delete-user": {
      if (!target) return err("User not found", 404);
      if (id === me.userId) return err("You cannot delete your own account");
      if (target.role === "admin" && (await activeAdmins(id)) === 0) return err("At least one active admin is required");
      await pool.query("delete from sessions where user_id = $1", [id]);
      await pool.query("delete from users where id = $1", [id]);
      forgetSessionCache();
      log("USER_DELETED", target.username);
      return NextResponse.json({ ok: true, message: `${target.username} deleted` });
    }
    case "revoke-session": {
      const sid = Number(body.sessionId);
      const r = await pool.query("update sessions set revoked_at = now() where id = $1 and revoked_at is null returning user_id", [sid]);
      forgetSessionCache();
      log("SESSION_REVOKED", `session #${sid}`, r.rows[0] ? `user #${r.rows[0].user_id}` : "");
      return NextResponse.json({ ok: true, message: "Session revoked" });
    }
    case "security": {
      const s = {
        idle: clamp(body.sessionIdleMinutes, 5, 1440, 120),
        max: clamp(body.sessionMaxHours, 1, 720, 12),
        attempts: clamp(body.maxLoginAttempts, 3, 20, 5),
        lockout: clamp(body.lockoutMinutes, 1, 1440, 15),
        minLen: clamp(body.passwordMinLength, 8, 64, 10),
        req2fa: !!body.require2faAdmin,
      };
      if (s.req2fa) {
        const self = (await pool.query("select totp_enabled from users where id = $1", [me.userId])).rows[0];
        if (!self?.totp_enabled) return err("Enable 2FA on your own account first (My Account tab), then require it for admins");
      }
      await pool.query(
        "update security_settings set session_idle_minutes = $1, session_max_hours = $2, max_login_attempts = $3, lockout_minutes = $4, password_min_length = $5, require_2fa_admin = $6, updated_at = now() where id = 1",
        [s.idle, s.max, s.attempts, s.lockout, s.minLen, s.req2fa],
      );
      forgetSessionCache();
      log("SECURITY_POLICY_UPDATED", "", JSON.stringify(s));
      return NextResponse.json({ ok: true, message: "Security policy saved", settings: await getSecurityConfig(true) });
    }
    case "factory-reset": {
      if (String(body.confirm) !== "RESET") return err('Type RESET to confirm (body.confirm = "RESET")');
      const keepBrokers = !!body.keepBrokers;
      const keepUsers = body.keepUsers !== false; // default: keep users
      await pool.query("delete from orders");
      await pool.query("delete from setups");
      await pool.query("delete from strategies");
      if (!keepBrokers) await pool.query("delete from brokers");
      if (!keepUsers) {
        await pool.query("delete from sessions where user_id <> $1", [me.userId]);
        await pool.query("delete from users where id <> $1", [me.userId]);
      }
      await pool.query(
        "update app_settings set capital = 10000, risk_per_trade_pct = 1, max_daily_loss_pct = 3, enforce_capital = true, auto_excel_minutes = 5, feed_broker_id = null, feed_auto_start = false, updated_at = now() where id = 1",
      );
      await pool.query("delete from audit_logs");
      forgetSessionCache();
      log("FACTORY_RESET", "", `brokers ${keepBrokers ? "kept" : "wiped"}, users ${keepUsers ? "kept" : "wiped"}`);
      return NextResponse.json({ ok: true, message: `Factory reset done — trading data cleared${keepBrokers ? "" : ", brokers removed"}, capital back to ₹10,000` });
    }
    case "clear-audit": {
      const days = clamp(body.olderThanDays, 7, 3650, 90);
      const r = await pool.query("delete from audit_logs where created_at < now() - make_interval(days => $1::int)", [days]);
      log("AUDIT_PURGED", "", `${r.rowCount} entries older than ${days} days`);
      return NextResponse.json({ ok: true, message: `${r.rowCount} old audit entries deleted` });
    }
    default:
      return err("Unknown action");
  }
}
