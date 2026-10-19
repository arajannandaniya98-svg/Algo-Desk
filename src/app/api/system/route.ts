import { pool } from "@/db";
import { ensureDatabase, explainDbError, REQUIRED_TABLES } from "@/lib/db-init";
import { getQuotes } from "@/lib/market";
import { getSettings } from "@/lib/capital";
import { NextRequest } from "next/server";
import { feedHub } from "@/lib/feed/hub";
import { secretKeySource } from "@/lib/security/secrets";

export const dynamic = "force-dynamic";

type Status = "ok" | "warn" | "fail";
interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
  hint?: string;
}

let ipCache: { ip: string; at: number } | null = null;
async function publicIp(): Promise<string | null> {
  if (ipCache && Date.now() - ipCache.at < 10 * 60_000) return ipCache.ip;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: ctrl.signal, cache: "no-store" });
    const j = (await r.json()) as { ip?: string };
    if (j.ip) {
      ipCache = { ip: j.ip, at: Date.now() };
      return j.ip;
    }
  } catch {
    /* offline */
  } finally {
    clearTimeout(timer);
  }
  return null;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** GET /api/system — installation & health checklist */
export async function GET() {
  const t0 = Date.now();
  const checks: Check[] = [];
  const counts = { instruments: 0, brokers: 0, liveBrokers: 0, setups: 0, orders: 0, strategies: 0 };
  let capital: { capital: number; riskPerTradePct: number; enforceCapital: boolean } | null = null;

  // 1. Node.js version (Next.js 16 needs >= 20.9)
  const [maj, min] = process.versions.node.split(".").map(Number);
  const nodeOk = maj > 20 || (maj === 20 && min >= 9);
  checks.push({ id: "node", label: "Node.js runtime", status: nodeOk ? "ok" : "fail", detail: `v${process.versions.node}`, hint: nodeOk ? undefined : "Install Node.js 22 LTS from nodejs.org" });

  // 2. Database connection
  let dbOk = false;
  try {
    const r = await pool.query("select version() as v, current_database() as d");
    const v = String(r.rows[0]?.v ?? "").split(" ").slice(0, 2).join(" ");
    dbOk = true;
    checks.push({ id: "db", label: "PostgreSQL database", status: "ok", detail: `${v} · database "${r.rows[0]?.d}"` });
  } catch (e) {
    checks.push({ id: "db", label: "PostgreSQL database", status: "fail", detail: explainDbError(e), hint: "Start PostgreSQL, check DATABASE_URL in .env, then click Repair database." });
  }

  // 3. Tables
  let tablesOk = false;
  if (dbOk) {
    try {
      const t = await pool.query("select table_name from information_schema.tables where table_schema = 'public'");
      const present = new Set(t.rows.map((x: { table_name: string }) => x.table_name));
      const missing = REQUIRED_TABLES.filter((x) => !present.has(x));
      tablesOk = missing.length === 0;
      checks.push({
        id: "tables",
        label: "Database tables",
        status: tablesOk ? "ok" : "fail",
        detail: tablesOk ? `${REQUIRED_TABLES.length}/${REQUIRED_TABLES.length} tables ready` : `Missing: ${missing.join(", ")}`,
        hint: tablesOk ? undefined : "Click Repair database to create them automatically.",
      });
    } catch (e) {
      checks.push({ id: "tables", label: "Database tables", status: "fail", detail: (e as Error).message });
    }
  }

  // 4. Market data feed (also seeds the instrument master on first run)
  if (tablesOk) {
    try {
      const q = await getQuotes(["NIFTY"]);
      const n = q.NIFTY;
      if (n?.source === "yahoo") {
        checks.push({ id: "yahoo", label: "Yahoo Finance feed", status: "ok", detail: `NIFTY ${n.ltp.toLocaleString("en-IN")} · ${n.marketState ?? "—"} · ~${n.delayedMinutes ?? 15} min delayed` });
      } else if (n) {
        checks.push({ id: "yahoo", label: "Yahoo Finance feed", status: "warn", detail: "Yahoo unreachable — simulator fallback active", hint: "Check internet / firewall. App keeps working with simulated prices." });
      } else {
        checks.push({ id: "yahoo", label: "Yahoo Finance feed", status: "fail", detail: "No quote returned" });
      }
    } catch (e) {
      checks.push({ id: "yahoo", label: "Yahoo Finance feed", status: "warn", detail: (e as Error).message });
    }

    try {
      const c = await pool.query(
        `select (select count(*) from instruments)::int as instruments,
                (select count(*) from brokers)::int as brokers,
                (select count(*) from brokers where mode = 'live')::int as live_brokers,
                (select count(*) from setups)::int as setups,
                (select count(*) from orders)::int as orders,
                (select count(*) from strategies)::int as strategies`,
      );
      const row = c.rows[0] ?? {};
      counts.instruments = Number(row.instruments) || 0;
      counts.brokers = Number(row.brokers) || 0;
      counts.liveBrokers = Number(row.live_brokers) || 0;
      counts.setups = Number(row.setups) || 0;
      counts.orders = Number(row.orders) || 0;
      counts.strategies = Number(row.strategies) || 0;
      checks.push({ id: "instruments", label: "Instrument master", status: counts.instruments > 0 ? "ok" : "warn", detail: `${counts.instruments} symbols (NSE · BSE · MCX · CDS)` });
    } catch {
      /* ignore */
    }

    try {
      const s = await getSettings();
      capital = { capital: s.capital, riskPerTradePct: s.riskPerTradePct, enforceCapital: s.enforceCapital };
      checks.push({ id: "capital", label: "Capital & risk", status: s.capital > 0 ? "ok" : "warn", detail: `${inr(s.capital)} · risk ${s.riskPerTradePct}%/trade · day-loss ${s.maxDailyLossPct}% · guard ${s.enforceCapital ? "ON" : "OFF"}` });
    } catch (e) {
      checks.push({ id: "capital", label: "Capital & risk", status: "warn", detail: (e as Error).message });
    }

    checks.push({
      id: "brokers",
      label: "Broker accounts",
      status: counts.brokers > 0 ? "ok" : "warn",
      detail: counts.brokers > 0 ? `${counts.brokers} configured · ${counts.liveBrokers} LIVE` : "None yet — paper simulator works without a broker",
      hint: counts.brokers > 0 ? undefined : "Brokers page → add Dhan / Angel One / Kotak Neo (start in Paper mode).",
    });
  }

  // 5. Excel engine
  try {
    const ExcelJS = await import("exceljs");
    checks.push({ id: "excel", label: "Excel report engine", status: typeof ExcelJS.Workbook === "function" || typeof ExcelJS.default?.Workbook === "function" ? "ok" : "warn", detail: "exceljs ready · 5-sheet .xlsx" });
  } catch (e) {
    checks.push({ id: "excel", label: "Excel report engine", status: "fail", detail: (e as Error).message, hint: "Run npm install" });
  }

  // 6. Security — users, 2FA, encryption, live feed
  let admin2fa = false;
  if (tablesOk) {
    try {
      const u = await pool.query(
        "select count(*)::int as users, (count(*) filter (where role = 'admin' and is_active))::int as admins, (count(*) filter (where role = 'admin' and is_active and totp_enabled))::int as admins2fa from users",
      );
      const { users = 0, admins = 0, admins2fa = 0 } = u.rows[0] ?? {};
      admin2fa = admins > 0 && admins2fa === admins;
      checks.push({
        id: "users",
        label: "Admin login & 2FA",
        status: admins === 0 ? "fail" : admin2fa ? "ok" : "warn",
        detail: admins === 0 ? "No admin account yet" : `${users} user(s) · ${admins} admin(s) · 2FA on ${admins2fa}/${admins}`,
        hint: admins === 0 ? "Open /login → create admin with the setup code from the server console" : admin2fa ? undefined : "Admin & Security → My Account → Enable 2FA",
      });
    } catch (e) {
      checks.push({ id: "users", label: "Admin login & 2FA", status: "warn", detail: (e as Error).message });
    }
  }
  const keySrc = secretKeySource();
  checks.push({
    id: "secrets",
    label: "Credential encryption",
    status: keySrc === "env" ? "ok" : "warn",
    detail: keySrc === "env" ? "AES-256-GCM · key from APP_SECRET" : "AES-256-GCM · auto key file .algodesk/secret.key",
    hint: keySrc === "env" ? undefined : "Run: node scripts/admin-cli.mjs init-env → restart → re-save broker credentials",
  });
  const fs0 = feedHub().status();
  const feedLive = fs0.state === "connected" && !fs0.simulated;
  checks.push({
    id: "feed",
    label: "Live market feed (0-delay)",
    status: feedLive ? "ok" : "warn",
    detail: fs0.state === "connected" ? `${fs0.simulated ? "DEMO (simulated)" : fs0.provider} · ${fs0.ticksPerSec} ticks/s · ${fs0.subscriptions} instruments` : "Off — prices from Yahoo (~15 min delay)",
    hint: feedLive ? undefined : "Live Feed page → connect a Dhan or Angel One account",
  });
  const passwordProtected = true;

  // 7. Public IP for broker static-IP whitelisting
  const ip = await publicIp();
  checks.push({
    id: "ip",
    label: "Public IP (broker whitelist)",
    status: ip ? "ok" : "warn",
    detail: ip ? `${ip} — register this static IP in your broker API portal for LIVE orders` : "Could not detect (offline?)",
  });

  const summary = { ok: 0, warn: 0, fail: 0 } as Record<Status, number>;
  for (const c of checks) summary[c.status]++;

  return Response.json({
    ok: summary.fail === 0,
    summary,
    checks,
    counts,
    capital,
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      env: process.env.NODE_ENV ?? "development",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: new Date().toISOString(),
      publicIp: ip,
      passwordProtected,
      admin2fa,
    },
    checkedMs: Date.now() - t0,
  });
}

/** POST /api/system { action: "repair" } — re-run database bootstrap */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.action !== "repair") return Response.json({ error: "unknown action" }, { status: 400 });
  try {
    const r = await ensureDatabase({ retries: 1 });
    return Response.json(r, { status: r.ok ? 200 : 207 });
  } catch (e) {
    return Response.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
