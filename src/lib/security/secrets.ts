import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import type { Broker } from "@/db/schema";

/**
 * AES-256-GCM encryption for secrets stored in PostgreSQL (broker API keys,
 * tokens, passwords, MPIN, 2FA secrets). Key = SHA-256(APP_SECRET); when
 * APP_SECRET is missing an auto-generated key is kept in .algodesk/secret.key.
 * Values look like  enc:v1:<iv>:<tag>:<ciphertext>  — plaintext from older
 * versions is still readable and gets encrypted on the next save / start.
 */
const PREFIX = "enc:v1:";
let keys: Buffer[] | null = null;
let source: "env" | "file" = "file";

const keyFile = () => path.join(/* turbopackIgnore: true */ process.cwd(), ".algodesk", "secret.key");
const derive = (s: string) => createHash("sha256").update(s).digest();

function readFileKey(): string | null {
  try {
    const k = fs.readFileSync(keyFile(), "utf8").trim();
    return k.length >= 32 ? k : null;
  } catch {
    return null;
  }
}

function loadKeys(): Buffer[] {
  if (keys) return keys;
  const env = process.env.APP_SECRET?.trim();
  const fileKey = readFileKey();
  if (env && env.length >= 16) {
    source = "env";
    // file key kept as fallback so secrets saved before APP_SECRET was set still open
    keys = [derive(env), ...(fileKey ? [derive(fileKey)] : [])];
    return keys;
  }
  let k = fileKey;
  if (!k) {
    k = randomBytes(32).toString("hex");
    try {
      fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
      fs.writeFileSync(keyFile(), k, { mode: 0o600 });
      console.warn("[AlgoDesk] Generated .algodesk/secret.key for encrypting credentials. Set APP_SECRET in .env (node scripts/admin-cli.mjs init-env).");
    } catch (e) {
      console.error(`[AlgoDesk] Could not save secret key: ${(e as Error).message}`);
    }
  }
  source = "file";
  keys = [derive(k)];
  return keys;
}

export function secretKeySource(): "env" | "file" {
  loadKeys();
  return source;
}

export const isSealed = (v: string | null | undefined) => !!v && v.startsWith(PREFIX);

export function seal(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(PREFIX)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKeys()[0], iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function open(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith(PREFIX)) return value;
  const [iv, tag, data] = value.slice(PREFIX.length).split(":");
  for (const key of loadKeys()) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
    } catch {
      /* try next key */
    }
  }
  return "";
}

export const MASK = "••••••••";
export function mask(value: string, showTail = true): string {
  const plain = open(value);
  if (!plain) return "";
  return showTail && plain.length > 10 ? `${MASK}${plain.slice(-4)}` : MASK;
}

// ---------- broker helpers ----------
export const BROKER_SECRET_FIELDS = ["apiKey", "apiSecret", "accessToken", "totpSecret", "password", "mpin"] as const;
type SecretField = (typeof BROKER_SECRET_FIELDS)[number];

/** Decrypt for server-side use (orders, login, live feed). Never send to the browser. */
export function openBroker(b: Broker): Broker {
  const out: Broker = { ...b };
  for (const f of BROKER_SECRET_FIELDS) out[f] = open(b[f]);
  out.extra = Object.fromEntries(Object.entries(b.extra ?? {}).map(([k, v]) => [k, open(String(v))]));
  return out;
}

/** Encrypt secret fields of an insert/update patch. */
export function sealBrokerPatch<T extends Record<string, unknown>>(patch: T): T {
  const out: Record<string, unknown> = { ...patch };
  for (const f of BROKER_SECRET_FIELDS) if (typeof out[f] === "string") out[f] = seal(out[f] as string);
  if (out.extra && typeof out.extra === "object") {
    out.extra = Object.fromEntries(Object.entries(out.extra as Record<string, unknown>).map(([k, v]) => [k, seal(String(v ?? ""))]));
  }
  return out as T;
}

/** Safe for API responses: secrets replaced by ••••. */
export function maskBroker(b: Broker): Broker {
  const out: Broker = { ...b };
  const tail: Record<SecretField, boolean> = { apiKey: true, apiSecret: false, accessToken: true, totpSecret: false, password: false, mpin: false };
  for (const f of BROKER_SECRET_FIELDS) out[f] = mask(b[f], tail[f]);
  out.extra = Object.fromEntries(Object.keys(b.extra ?? {}).map((k) => [k, b.extra[k] ? MASK : ""]));
  return out;
}
