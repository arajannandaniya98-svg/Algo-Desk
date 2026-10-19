export const fmt = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-IN"));

export const fmtCr = (n: number) => (n >= 100000 ? `${(n / 100000).toFixed(2)} L Cr` : n > 0 ? `${fmtInt(Math.round(n))} Cr` : "—");

export const fmtOi = (n: number) => (n >= 10_000_000 ? `${(n / 10_000_000).toFixed(2)}Cr` : n >= 100_000 ? `${(n / 100_000).toFixed(2)}L` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

export const statusColor: Record<string, string> = {
  DRAFT: "bg-slate-500/20 text-slate-300",
  ACTIVE: "bg-amber-500/20 text-amber-300",
  ENTERED: "bg-sky-500/20 text-sky-300",
  EXITED: "bg-emerald-500/20 text-emerald-300",
  CANCELLED: "bg-red-500/20 text-red-300",
  FILLED: "bg-emerald-500/20 text-emerald-300",
  PENDING: "bg-amber-500/20 text-amber-300",
  REJECTED: "bg-red-500/20 text-red-300",
};

export const providerName: Record<string, string> = { dhan: "Dhan", angelone: "Angel One", kotakneo: "Kotak Neo", deltaexchange: "Delta Exchange", zerodha: "Zerodha", upstox: "Upstox", fyers: "Fyers", shoonya: "Shoonya", flattrade: "Flattrade", aliceblue: "Alice Blue", fivepaisa: "5paisa", icicibreeze: "ICICI Breeze", paper: "Paper" };

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth") && window.location.pathname !== "/login") {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (r.status === 403 && (j as { code?: string }).code === "ACCOUNT_ACTION_REQUIRED" && typeof window !== "undefined" && !window.location.pathname.startsWith("/admin")) {
    window.location.href = "/admin?tab=account";
  }
  if (!r.ok) throw new Error((j as { error?: string; message?: string }).error || (j as { message?: string }).message || `HTTP ${r.status}`);
  return j as T;
}
