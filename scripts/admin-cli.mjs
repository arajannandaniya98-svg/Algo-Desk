#!/usr/bin/env node
/**
 * AlgoDesk admin CLI — run on the server (needs access to .env / PostgreSQL).
 *
 *   node scripts/admin-cli.mjs init-env                         create .env + strong APP_SECRET
 *   node scripts/admin-cli.mjs list                             list users
 *   node scripts/admin-cli.mjs create <user> <password> [role]  role: admin | trader | viewer
 *   node scripts/admin-cli.mjs reset-password <user> <password> forgot password / locked out
 *   node scripts/admin-cli.mjs unlock <user>                    clear failed-login lock
 *   node scripts/admin-cli.mjs disable-2fa <user>               lost phone
 *
 * Tip: wrap passwords with symbols in quotes:  "My#Strong@Pass1"
 */
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...args] = process.argv.slice(2);

function initEnv() {
  const envFile = path.join(root, ".env");
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(root, ".env.example"), envFile);
    console.log("[OK] Created .env from .env.example");
  }
  let txt = fs.readFileSync(envFile, "utf8");
  if (/^APP_SECRET=\S{16,}/m.test(txt)) {
    console.log("[OK] APP_SECRET already set");
    return;
  }
  const secret = randomBytes(32).toString("hex");
  txt = /^APP_SECRET=.*$/m.test(txt) ? txt.replace(/^APP_SECRET=.*$/m, `APP_SECRET=${secret}`) : `${txt.trimEnd()}\nAPP_SECRET=${secret}\n`;
  fs.writeFileSync(envFile, txt);
  console.log("[OK] Generated APP_SECRET in .env — keep a safe backup of this file (it decrypts broker credentials)");
}

const USAGE = `Usage:
  node scripts/admin-cli.mjs init-env
  node scripts/admin-cli.mjs list
  node scripts/admin-cli.mjs create <username> <password> [admin|trader|viewer]
  node scripts/admin-cli.mjs reset-password <username> <newPassword>
  node scripts/admin-cli.mjs unlock <username>
  node scripts/admin-cli.mjs disable-2fa <username>`;

if (cmd === "init-env") {
  initEnv();
  process.exit(0);
}
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(USAGE);
  process.exit(0);
}

const dotenv = await import("dotenv");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
if (!process.env.DATABASE_URL) {
  console.error("[X] DATABASE_URL missing — run: node scripts/admin-cli.mjs init-env  and edit .env");
  process.exit(1);
}
const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

// must match src/lib/security/password.ts
const N = 32768;
const R = 8;
const P = 1;
const hash = (pw) =>
  new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scryptCb(pw.normalize("NFKC"), salt, 64, { N, r: R, p: P, maxmem: 96 * 1024 * 1024 }, (e, k) =>
      e ? reject(e) : resolve(`scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${k.toString("base64")}`),
    );
  });
const weak = (pw) => (!pw || pw.length < 10 ? "Password must be at least 10 characters" : !/[a-z]/i.test(pw) || !/\d/.test(pw) ? "Password must contain letters and numbers" : null);
const need = (v, what) => {
  if (!v) {
    console.error(`[X] Missing ${what}\n\n${USAGE}`);
    process.exit(1);
  }
  return v;
};

async function audit(username, action, detail = "") {
  await pool.query("insert into audit_logs (username, action, detail, ip, user_agent) values ($1, $2, $3, 'server-cli', 'admin-cli')", [username, action, detail]).catch(() => {});
}

async function main() {
  const user = (args[0] ?? "").toLowerCase();
  switch (cmd) {
    case "list": {
      const r = await pool.query("select id, username, role, is_active, totp_enabled, locked_until, last_login_at from users order by id");
      if (!r.rows.length) console.log("No users yet — start the app and use the setup code, or: create <user> <password> admin");
      for (const u of r.rows) {
        const locked = u.locked_until && new Date(u.locked_until) > new Date();
        console.log(`#${u.id}  ${u.username.padEnd(16)} ${u.role.padEnd(7)} ${u.is_active ? "active  " : "DISABLED"} 2FA:${u.totp_enabled ? "on " : "off"} ${locked ? "LOCKED" : ""}  last login: ${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "-"}`);
      }
      break;
    }
    case "create": {
      const pw = need(args[1], "password");
      const role = args[2] ?? "admin";
      if (!/^[a-z0-9._-]{3,32}$/.test(need(user, "username"))) throw new Error("Username: 3-32 chars a-z 0-9 . _ -");
      if (!["admin", "trader", "viewer"].includes(role)) throw new Error("Role must be admin, trader or viewer");
      const problem = weak(pw);
      if (problem) throw new Error(problem);
      const r = await pool.query("insert into users (username, display_name, password_hash, role) values ($1, $2, $3, $4) on conflict (username) do nothing returning id", [user, user, await hash(pw), role]);
      if (!r.rows[0]) throw new Error(`User ${user} already exists — use reset-password`);
      await audit(user, "USER_CREATED_CLI", `role ${role}`);
      console.log(`[OK] Created ${role} user "${user}"`);
      break;
    }
    case "reset-password": {
      const pw = need(args[1], "new password");
      const problem = weak(pw);
      if (problem) throw new Error(problem);
      const r = await pool.query(
        "update users set password_hash = $1, must_change_password = false, failed_attempts = 0, locked_until = null, is_active = true, password_changed_at = now(), updated_at = now() where username = $2 returning id",
        [await hash(pw), need(user, "username")],
      );
      if (!r.rows[0]) throw new Error(`User ${user} not found (see: list)`);
      await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [r.rows[0].id]);
      await audit(user, "PASSWORD_RESET_CLI", "all sessions signed out");
      console.log(`[OK] Password reset for "${user}" — account unlocked, all sessions signed out`);
      break;
    }
    case "unlock": {
      const r = await pool.query("update users set failed_attempts = 0, locked_until = null, updated_at = now() where username = $1 returning id", [need(user, "username")]);
      if (!r.rows[0]) throw new Error(`User ${user} not found`);
      await audit(user, "USER_UNLOCKED_CLI");
      console.log(`[OK] "${user}" unlocked`);
      break;
    }
    case "disable-2fa": {
      const r = await pool.query("update users set totp_enabled = false, totp_secret = '', totp_last_counter = 0, updated_at = now() where username = $1 returning id", [need(user, "username")]);
      if (!r.rows[0]) throw new Error(`User ${user} not found`);
      await audit(user, "2FA_RESET_CLI");
      console.log(`[OK] 2FA removed for "${user}" — enable it again after login`);
      break;
    }
    default:
      console.log(USAGE);
  }
}

main()
  .catch((e) => {
    console.error(`[X] ${e.message}${/relation .* does not exist/.test(e.message) ? " — start the app once so it creates the tables" : ""}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
