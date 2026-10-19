import { randomInt } from "crypto";
import { pool } from "@/db";
import { hashPassword, passwordProblems } from "./password";
import { isSealed, seal } from "./secrets";
import { sha256 } from "./session";

export async function userCount(): Promise<number> {
  const r = await pool.query("select count(*)::int as n from users");
  return Number(r.rows[0]?.n ?? 0);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion

/**
 * One-time setup code for creating the first admin from the browser. Printed
 * only in the server console, so a stranger who finds a fresh VPS URL cannot
 * claim the admin account.
 */
export async function ensureSetupCode(force = false): Promise<void> {
  await pool.query("insert into security_settings (id) values (1) on conflict (id) do nothing");
  if (!force) {
    const r = await pool.query("select setup_code_hash, setup_code_expires from security_settings where id = 1");
    const row = r.rows[0];
    if (row?.setup_code_hash && row.setup_code_expires && new Date(row.setup_code_expires) > new Date()) return;
  }
  let raw = "";
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  await pool.query("update security_settings set setup_code_hash = $1, setup_code_expires = now() + interval '24 hours' where id = 1", [sha256(code)]);
  const line = "=".repeat(62);
  console.log(`\n${line}\n  AlgoDesk FIRST-RUN SETUP CODE:   ${code}\n  Open http://localhost:3000/login and create the ADMIN account.\n  (valid 24 hours · a new code is printed on every restart)\n${line}\n`);
}

/**
 * Runs on server start:
 *  1. creates the first admin from ADMIN_USERNAME / ADMIN_PASSWORD (or legacy APP_PASSWORD)
 *  2. otherwise prints a setup code
 *  3. encrypts plaintext broker secrets left from older versions
 */
export async function bootstrapSecurity(): Promise<void> {
  await pool.query("insert into security_settings (id) values (1) on conflict (id) do nothing");

  if ((await userCount()) === 0) {
    const envUser = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
    const envPass = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || "";
    if (envUser && envPass && !passwordProblems(envPass, 8, envUser)) {
      await pool.query(
        "insert into users (username, display_name, password_hash, role) select $1, 'Administrator', $2, 'admin' where not exists (select 1 from users)",
        [envUser, await hashPassword(envPass)],
      );
      console.log(`[AlgoDesk] Admin user "${envUser}" created from .env — remove ADMIN_PASSWORD after first login.`);
    } else {
      // Default first login: admin / admin — app forces a password change immediately after login.
      await pool.query(
        "insert into users (username, display_name, password_hash, role, must_change_password) select 'admin', 'Administrator', $1, 'admin', true where not exists (select 1 from users)",
        [await hashPassword("admin")],
      );
      const line = "=".repeat(62);
      console.log(`\n${line}\n  AlgoDesk DEFAULT LOGIN:   username  admin   ·   password  admin\n  First login par navo strong password set karvo FARAJIYAT chhe.\n${line}\n`);
    }
  }

  const cols = ["api_key", "api_secret", "access_token", "totp_secret", "password", "mpin"] as const;
  const rows = await pool.query(`select id, ${cols.join(", ")}, extra from brokers`);
  let migrated = 0;
  for (const row of rows.rows) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const c of cols) {
      if (row[c] && !isSealed(row[c])) {
        vals.push(seal(row[c]));
        sets.push(`${c} = $${vals.length}`);
      }
    }
    const extra = { ...(row.extra ?? {}) } as Record<string, string>;
    let extraChanged = false;
    for (const k of Object.keys(extra)) {
      if (extra[k] && !isSealed(String(extra[k]))) {
        extra[k] = seal(String(extra[k]));
        extraChanged = true;
      }
    }
    if (extraChanged) {
      vals.push(JSON.stringify(extra));
      sets.push(`extra = $${vals.length}::jsonb`);
    }
    if (sets.length) {
      vals.push(row.id);
      await pool.query(`update brokers set ${sets.join(", ")} where id = $${vals.length}`, vals);
      migrated++;
    }
  }
  if (migrated) console.log(`[AlgoDesk] Encrypted stored credentials for ${migrated} broker account(s).`);
}
