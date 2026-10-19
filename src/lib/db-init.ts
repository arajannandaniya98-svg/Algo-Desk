import { Pool } from "pg";
import { SCHEMA_STATEMENTS, SCHEMA_TABLES } from "./schema-sql";

export const REQUIRED_TABLES = SCHEMA_TABLES;

export interface DbInitResult {
  ok: boolean;
  createdDatabase: boolean;
  applied: number;
  total: number;
  warnings: string[];
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || "postgres";
  } catch {
    return "app_db";
  }
}

/** Human friendly hint for the most common PostgreSQL connection errors. */
export function explainDbError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const msg = err?.message ?? String(e);
  if (err?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) return `${msg} — PostgreSQL is not running. Start the PostgreSQL service (Windows: Services → postgresql-x64-16 → Start).`;
  if (err?.code === "28P01" || /password authentication failed/i.test(msg)) return `${msg} — wrong DB password. Fix DATABASE_URL in .env.`;
  if (err?.code === "ENOTFOUND" || /ENOTFOUND/.test(msg)) return `${msg} — DB host not found. Check host in DATABASE_URL.`;
  if (err?.code === "3D000") return `${msg} — database missing (auto-create failed; create it manually).`;
  return msg;
}

async function probe(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 6000 });
  try {
    await pool.query("select 1");
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Creates the target database when PostgreSQL reports it does not exist (3D000). */
async function createDatabaseIfMissing(url: string): Promise<boolean> {
  try {
    await probe(url);
    return false;
  } catch (e) {
    if ((e as { code?: string }).code !== "3D000") throw e;
  }
  const name = databaseName(url);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const pool = new Pool({ connectionString: admin.toString(), max: 1, connectionTimeoutMillis: 6000 });
  try {
    await pool.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } catch (e) {
    // another process may have created it at the same time
    if ((e as { code?: string }).code === "42P04") return false;
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Idempotent database bootstrap used on every server start and by the
 * "Repair database" button: creates the database, all tables and any
 * columns added in newer versions. Safe to run repeatedly.
 */
export async function ensureDatabase(opts: { retries?: number } = {}): Promise<DbInitResult> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return { ok: false, createdDatabase: false, applied: 0, total: SCHEMA_STATEMENTS.length, warnings: [], message: "DATABASE_URL is not set — copy .env.example to .env" };
  }

  const retries = opts.retries ?? 0;
  let createdDatabase = false;
  for (let attempt = 0; ; attempt++) {
    try {
      createdDatabase = await createDatabaseIfMissing(url);
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      const transient = code === "ECONNREFUSED" || code === "57P03" || code === "ETIMEDOUT";
      if (!transient || attempt >= retries) throw new Error(explainDbError(e));
      await sleep(2000);
    }
  }

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 6000 });
  const warnings: string[] = [];
  let applied = 0;
  try {
    for (const stmt of SCHEMA_STATEMENTS) {
      try {
        await pool.query(stmt);
        applied++;
      } catch (e) {
        warnings.push(`${stmt.replace(/\s+/g, " ").slice(0, 70)}… → ${(e as Error).message}`);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }

  return {
    ok: warnings.length === 0,
    createdDatabase,
    applied,
    total: SCHEMA_STATEMENTS.length,
    warnings,
    message: `${createdDatabase ? `Database "${databaseName(url)}" created. ` : ""}Schema ready — ${applied}/${SCHEMA_STATEMENTS.length} statements OK${warnings.length ? `, ${warnings.length} warning(s)` : ""}.`,
  };
}
