import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** RFC 6238 TOTP (Google Authenticator / Microsoft Authenticator / Authy compatible). */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return (bin % 1_000_000).toString().padStart(6, "0");
}

/**
 * Verifies a 6 digit code (±1 step = ±30s clock drift). Returns the matched
 * counter so callers can store it and reject re-use (replay protection).
 */
export function verifyTotp(secret: string, code: string, lastCounter = 0, window = 1): number | null {
  const clean = String(code ?? "").replace(/\s+/g, "");
  if (!secret || !/^\d{6}$/.test(clean)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    const ctr = now + w;
    if (ctr <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, ctr)), Buffer.from(clean))) return ctr;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = "AlgoDesk India"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
