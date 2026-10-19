import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";

/**
 * Password hashing with scrypt (memory-hard, built into Node — no native deps).
 * Format: scrypt$N$r$p$saltB64$hashB64  (parameters stored so they can be raised later)
 */
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 96 * 1024 * 1024;

function derive(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  try {
    const key = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

let dummyHash: string | null = null;
/** Spend the same time as a real check so unknown usernames can't be detected by timing. */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= await hashPassword("algodesk-timing-equaliser-9f2c");
  await verifyPassword(password, dummyHash);
}

const COMMON = ["password", "123456", "12345678", "qwerty", "admin", "welcome", "letmein", "iloveyou", "abc123", "111111", "000000", "trading", "nifty", "sensex", "algodesk", "india123"];

/** Returns a human readable problem, or null when the password is acceptable. */
export function passwordProblems(password: string, minLength = 10, username?: string): string | null {
  if (password.length < minLength) return `Password must be at least ${minLength} characters`;
  if (password.length > 128) return "Password is too long (max 128 characters)";
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return "Password must contain letters and numbers";
  if (!/[^a-z0-9]/i.test(password) && !(/[a-z]/.test(password) && /[A-Z]/.test(password))) return "Add an UPPERCASE letter or a symbol (@ # $ % …)";
  const lower = password.toLowerCase();
  if (COMMON.some((c) => lower.includes(c) && lower.length <= c.length + 4)) return "Password is too common — choose something unique";
  if (/(.)\1{3,}/.test(password)) return "Password must not repeat the same character 4+ times";
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) return "Password must not contain the username";
  return null;
}
