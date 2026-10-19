import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/security/audit";
import { clientIp, embedAllowed, getSecurityConfig, isHttps, lookupSession, ROLE_RANK, SESSION_COOKIE, type Role, type SessionUser } from "@/lib/security/session";

/**
 * Security gate for every page + API request:
 *  • session cookie → DB-validated user (idle + absolute expiry, revocation)
 *  • role based access control (admin / trader / viewer)
 *  • forced password change / admin 2FA enrolment
 *  • CSRF: cross-origin state-changing requests rejected
 *  • security headers (CSP, clickjacking, HSTS, nosniff …)
 *  • audit trail of every state-changing API call
 */
const PUBLIC_PATHS = ["/login", "/api/auth", "/api/health"];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const IDENTITY_HEADERS = ["x-user-id", "x-user-name", "x-user-role", "x-session-id", "x-client-ip"];
const isDev = process.env.NODE_ENV !== "production";

function requiredRole(method: string, p: string): Role {
  const write = !SAFE.has(method);
  if (p.startsWith("/api/admin")) return "admin";
  if (p.startsWith("/api/account") || p.startsWith("/api/stream")) return "viewer";
  if (p.startsWith("/api/system")) return write ? "admin" : "trader";
  if (p.startsWith("/api/feed")) return write ? "admin" : "viewer";
  if (p === "/api/brokers") return write ? "admin" : "viewer";
  if (p.startsWith("/api/brokers/")) return method === "POST" ? "trader" : write ? "admin" : "viewer";
  if ((p.startsWith("/api/orders") || p.startsWith("/api/instruments")) && method === "DELETE") return "admin";
  if (p === "/api/settings" && method === "POST") return "viewer"; // position-size calculator (read only)
  if (p.startsWith("/api/") && write) return "trader";
  return "viewer";
}

function shouldAudit(req: NextRequest): boolean {
  const p = req.nextUrl.pathname;
  if (/^\/api\/(engine|auth|account|admin|stream)/.test(p)) return false; // high-frequency or self-audited
  if (p === "/api/strategies" && req.nextUrl.searchParams.get("action") === "preview") return false;
  if (p === "/api/settings" && req.method === "POST") return false;
  return true;
}

function secure(res: NextResponse, req: NextRequest): NextResponse {
  const embed = embedAllowed();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://s3.tradingview.com https://*.tradingview.com${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://*.tradingview.com",
    "img-src 'self' data: blob: https://*.tradingview.com",
    "font-src 'self' data:",
    `connect-src 'self' https://*.tradingview.com wss://*.tradingview.com${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embed ? "*" : "'none'"}`,
  ].join("; ");
  res.headers.set("Content-Security-Policy", csp);
  if (!embed) res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (isHttps(req)) res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return res;
}

const deny = (req: NextRequest, status: number, error: string, code?: string) => secure(NextResponse.json({ error, code }, { status }), req);

function toLogin(req: NextRequest) {
  const url = new URL("/login", req.url);
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (next !== "/") url.searchParams.set("next", next);
  return secure(NextResponse.redirect(url), req);
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients never carry the victim's cookie
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = new Set([req.headers.get("host"), req.headers.get("x-forwarded-host"), req.nextUrl.host].filter(Boolean) as string[]);
  for (const o of (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      allowed.add(new URL(o).host);
    } catch {
      /* ignore bad entry */
    }
  }
  return allowed.has(host);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method;
  const isApi = pathname.startsWith("/api/");

  if (!SAFE.has(method) && !sameOrigin(req)) return deny(req, 403, "Cross-origin request blocked (CSRF protection)", "CSRF");

  const headers = new Headers(req.headers);
  for (const h of IDENTITY_HEADERS) headers.delete(h);
  const ip = clientIp(req.headers);
  headers.set("x-client-ip", ip);

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return secure(NextResponse.next({ request: { headers } }), req);
  }

  let user: SessionUser | null = null;
  try {
    user = await lookupSession(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    if (isApi) return deny(req, 503, "Database unavailable — start PostgreSQL and retry", "DB_DOWN");
    return toLogin(req);
  }
  if (!user) return isApi ? deny(req, 401, "Login required", "AUTH_REQUIRED") : toLogin(req);

  const cfg = await getSecurityConfig().catch(() => null);
  const needs2fa = !!cfg?.require2faAdmin && user.role === "admin" && !user.totpEnabled;
  if ((user.mustChangePassword || needs2fa) && !pathname.startsWith("/admin") && !pathname.startsWith("/api/account")) {
    if (isApi) return deny(req, 403, user.mustChangePassword ? "Password change required" : "Two-factor authentication setup required", "ACCOUNT_ACTION_REQUIRED");
    return secure(NextResponse.redirect(new URL("/admin?tab=account", req.url)), req);
  }

  const need = requiredRole(method, pathname);
  if (ROLE_RANK[user.role] < ROLE_RANK[need]) {
    if (isApi) return deny(req, 403, `Permission denied — ${need} role required`, "FORBIDDEN");
    return secure(NextResponse.redirect(new URL("/?denied=1", req.url)), req);
  }

  headers.set("x-user-id", String(user.userId));
  headers.set("x-user-name", user.username);
  headers.set("x-user-role", user.role);
  headers.set("x-session-id", String(user.sessionId));

  if (isApi && !SAFE.has(method) && shouldAudit(req)) {
    audit({ userId: user.userId, username: user.username, action: `${method} ${pathname}`, target: req.nextUrl.search.slice(0, 200), ip, userAgent: req.headers.get("user-agent") ?? "" });
  }
  return secure(NextResponse.next({ request: { headers } }), req);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
