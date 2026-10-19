type Bucket = { n: number; reset: number };
const g = globalThis as unknown as { __algodeskRate?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__algodeskRate ??= new Map());

/** Fixed-window in-memory limiter (single server process). */
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { n: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.n++;
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return { ok: b.n <= limit, remaining: Math.max(0, limit - b.n), retryAfterSec: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
}

export function rateReset(key: string) {
  buckets.delete(key);
}
