import { createHash, randomBytes } from "crypto";
import { pool } from "@/db";

export const SESSION_COOKIE = "algodesk_session";
export type Role = "admin" | "trader" | "viewer";
export const ROLES: Role[] = ["admin", "trader", "viewer"];
export const ROLE_RANK: Record<Role, number> = { viewer: 1, trader: 2, admin: 3 };

export interface SessionUser {
  sessionId: number;
  userId: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  totpEnabled: boolean;
}

export interface SecurityConfig {
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  maxLoginAttempts: number;
  lockoutMinutes: number;
  passwordMinLength: number;
  require2faAdmin: boolean;
}

export const DEFAULT_SECURITY: SecurityConfig = {
  sessionIdleMinutes: 120,
  sessionMaxHours: 12,
  maxLoginAttempts: 5,
  lockoutMinutes: 15,
  passwordMinLength: 10,
  require2faAdmin: false,
};

type Cache = { sessions: Map<string, { user: SessionUser | null; at: number }>; cfg: { v: SecurityConfig | null; at: number } };
const g = globalThis as unknown as { __algodeskAuthCache?: Cache };
const cache: Cache = (g.__algodeskAuthCache ??= { sessions: new Map(), cfg: { v: null, at: 0 } });

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Call after logout / revoke / role change so the next request re-checks the DB. */
export function forgetSessionCache() {
  cache.sessions.clear();
  cache.cfg.at = 0;
}

export async function getSecurityConfig(force = false): Promise<SecurityConfig> {
  if (!force && cache.cfg.v && Date.now() - cache.cfg.at < 30_000) return cache.cfg.v;
  await pool.query("insert into security_settings (id) values (1) on conflict (id) do nothing");
  const r = await pool.query(
    "select session_idle_minutes, session_max_hours, max_login_attempts, lockout_minutes, password_min_length, require_2fa_admin from security_settings where id = 1",
  );
  const row = r.rows[0] ?? {};
  const v: SecurityConfig = {
    sessionIdleMinutes: Number(row.session_idle_minutes) || DEFAULT_SECURITY.sessionIdleMinutes,
    sessionMaxHours: Number(row.session_max_hours) || DEFAULT_SECURITY.sessionMaxHours,
    maxLoginAttempts: Number(row.max_login_attempts) || DEFAULT_SECURITY.maxLoginAttempts,
    lockoutMinutes: Number(row.lockout_minutes) || DEFAULT_SECURITY.lockoutMinutes,
    passwordMinLength: Number(row.password_min_length) || DEFAULT_SECURITY.passwordMinLength,
    require2faAdmin: !!row.require_2fa_admin,
  };
  cache.cfg = { v, at: Date.now() };
  return v;
}

/** Validates the opaque session cookie against the DB (10s in-memory cache). */
export async function lookupSession(token: string | null | undefined): Promise<SessionUser | null> {
  if (!token || token.length < 30 || token.length > 200) return null;
  const h = sha256(token);
  const hit = cache.sessions.get(h);
  if (hit && Date.now() - hit.at < 10_000) return hit.user;

  const cfg = await getSecurityConfig();
  const r = await pool.query(
    `select s.id as sid, s.last_seen_at, u.id as uid, u.username, u.display_name, u.role, u.must_change_password, u.totp_enabled
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.is_active = true
      limit 1`,
    [h],
  );
  const row = r.rows[0];
  let user: SessionUser | null = null;
  if (row) {
    const idle = Date.now() - new Date(row.last_seen_at).getTime();
    if (idle <= cfg.sessionIdleMinutes * 60_000) {
      user = {
        sessionId: row.sid,
        userId: row.uid,
        username: row.username,
        displayName: row.display_name || row.username,
        role: (ROLES as string[]).includes(row.role) ? (row.role as Role) : "viewer",
        mustChangePassword: !!row.must_change_password,
        totpEnabled: !!row.totp_enabled,
      };
      if (idle > 60_000) pool.query("update sessions set last_seen_at = now() where id = $1", [row.sid]).catch(() => {});
    } else {
      pool.query("update sessions set revoked_at = now() where id = $1", [row.sid]).catch(() => {});
    }
  }
  if (cache.sessions.size > 5000) cache.sessions.clear();
  cache.sessions.set(h, { user, at: Date.now() });
  return user;
}

export async function createSession(userId: number, ip: string, userAgent: string) {
  const cfg = await getSecurityConfig();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + cfg.sessionMaxHours * 3_600_000);
  await pool.query("insert into sessions (token_hash, user_id, ip, user_agent, expires_at) values ($1, $2, $3, $4, $5)", [
    sha256(token),
    userId,
    ip.slice(0, 64),
    userAgent.slice(0, 300),
    expiresAt,
  ]);
  return { token, expiresAt, maxAgeSec: cfg.sessionMaxHours * 3600 };
}

export async function revokeSessionToken(token: string) {
  await pool.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
  cache.sessions.delete(sha256(token));
}

export function clientIp(h: Headers): string {
  return (h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local").slice(0, 64);
}

type ReqLike = { headers: Headers; nextUrl: { protocol: string } };
export const isHttps = (req: ReqLike) => req.nextUrl.protocol === "https:" || (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
/** Online preview runs inside an iframe; real installs deny framing (clickjacking protection). */
export const embedAllowed = () => process.env.ALLOW_EMBED === "1" || !!process.env.E2B_SANDBOX;

export function sessionCookie(req: ReqLike, value: string, maxAge: number) {
  // Online preview is served over HTTPS behind a proxy that may not send X-Forwarded-Proto
  const embed = embedAllowed();
  const secure = isHttps(req) || embed;
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    secure,
    sameSite: (embed ? "none" : "lax") as "none" | "lax",
    path: "/",
    maxAge,
    ...(embed ? { partitioned: true } : {}),
  };
}
