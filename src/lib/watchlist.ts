export type WatchlistKind = "STOCK" | "INDEX" | "OPTION" | "CRYPTO" | "COMMODITY";

export interface WatchlistItem {
  id: string; // unique key, e.g. "STOCK:TRENT" or "OPT:NIFTY:22500:CE:2026-10-13"
  kind: WatchlistKind;
  symbol: string; // Display symbol, e.g. "TRENT" or "NIFTY 22500 CE"
  tradingSymbol?: string; // Broker tradingsymbol e.g. "NIFTY26OCT22500CE"
  name: string; // Company / instrument name e.g. "Trent Ltd"
  exchange: string; // "NSE", "BSE", "DELTA", "MCX"
  segment: string; // "EQ", "OPT", "FUT", "CRYPTO"
  lotSize: number;
  underlying?: string; // For options: "NIFTY"
  strike?: number;
  otype?: "CE" | "PE";
  expiry?: string;
  brokerToken?: string;
  basePrice?: number;
  addedAt: number;
}

export const WATCHLIST_STORAGE_KEY = "algodesk.custom_watchlist";

// Default Top Indian Momentum Stocks + Core Indices + Crypto
export const DEFAULT_WATCHLIST: WatchlistItem[] = [
  // 🇮🇳 Top Momentum Indian Stocks
  {
    id: "STOCK:TRENT",
    kind: "STOCK",
    symbol: "TRENT",
    name: "Trent Ltd (Retail Leader)",
    exchange: "NSE",
    segment: "EQ",
    lotSize: 100,
    addedAt: 1,
  },
  {
    id: "STOCK:BEL",
    kind: "STOCK",
    symbol: "BEL",
    name: "Bharat Electronics (Defence Momentum)",
    exchange: "NSE",
    segment: "EQ",
    lotSize: 2850,
    addedAt: 2,
  },
  {
    id: "STOCK:HAL",
    kind: "STOCK",
    symbol: "HAL",
    name: "Hindustan Aeronautics (Defence Leader)",
    exchange: "NSE",
    segment: "EQ",
    lotSize: 150,
    addedAt: 3,
  },
  {
    id: "STOCK:ZOMATO",
    kind: "STOCK",
    symbol: "ZOMATO",
    name: "Zomato Ltd (High Growth Momentum)",
    exchange: "NSE",
    segment: "EQ",
    lotSize: 2000,
    addedAt: 4,
  },
  {
    id: "STOCK:DIXON",
    kind: "STOCK",
    symbol: "DIXON",
    name: "Dixon Technologies (Electronics Leader)",
    exchange: "NSE",
    segment: "EQ",
    lotSize: 50,
    addedAt: 5,
  },
  {
    id: "STOCK:SUZLON",
    kind: "STOCK",
    symbol: "SUZLON",
    name: "Suzlon Energy (Clean Energy Surge)",
    exchange: "NSE",
    segment: "EQ",
    lotSize: 8000,
    addedAt: 6,
  },
  {
    id: "STOCK:RELIANCE",
    kind: "STOCK",
    symbol: "RELIANCE",
    name: "Reliance Industries",
    exchange: "NSE",
    segment: "EQ",
    lotSize: 500,
    addedAt: 7,
  },
  {
    id: "INDEX:NIFTY",
    kind: "INDEX",
    symbol: "NIFTY",
    name: "Nifty 50 Index",
    exchange: "NSE",
    segment: "INDEX",
    lotSize: 65,
    addedAt: 8,
  },
  {
    id: "INDEX:BANKNIFTY",
    kind: "INDEX",
    symbol: "BANKNIFTY",
    name: "Bank Nifty Index",
    exchange: "NSE",
    segment: "INDEX",
    lotSize: 30,
    addedAt: 9,
  },
  {
    id: "CRYPTO:BTCUSD",
    kind: "CRYPTO",
    symbol: "BTCUSD",
    name: "Bitcoin Perpetual",
    exchange: "DELTA",
    segment: "CRYPTO",
    lotSize: 1,
    addedAt: 10,
  },
];

/** Read watchlist from localStorage with fallback */
export function getStoredWatchlist(): WatchlistItem[] {
  if (typeof window === "undefined") return DEFAULT_WATCHLIST;
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(DEFAULT_WATCHLIST));
      return DEFAULT_WATCHLIST;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return DEFAULT_WATCHLIST;
  } catch {
    return DEFAULT_WATCHLIST;
  }
}

/** Save watchlist to localStorage and notify all components across the app */
export function saveWatchlist(items: WatchlistItem[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent("algodesk-watchlist-updated", { detail: { items } }));
  } catch {
    // ignore
  }
}

/** Check if item exists in watchlist */
export function isInWatchlist(id: string, list?: WatchlistItem[]): boolean {
  const current = list ?? getStoredWatchlist();
  return current.some((it) => it.id === id);
}

/** Helper to add stock or instrument to watchlist */
export function addStockToWatchlist(item: {
  symbol: string;
  name?: string;
  exchange?: string;
  segment?: string;
  lotSize?: number;
}): { ok: boolean; message: string } {
  const current = getStoredWatchlist();
  const id = `${item.segment === "CRYPTO" ? "CRYPTO" : item.segment === "INDEX" ? "INDEX" : "STOCK"}:${item.symbol.toUpperCase()}`;
  if (current.some((it) => it.id === id)) {
    return { ok: false, message: `${item.symbol} is already in your watchlist` };
  }

  const newItem: WatchlistItem = {
    id,
    kind: item.segment === "CRYPTO" ? "CRYPTO" : item.segment === "INDEX" ? "INDEX" : "STOCK",
    symbol: item.symbol.toUpperCase(),
    name: item.name || item.symbol.toUpperCase(),
    exchange: item.exchange || "NSE",
    segment: item.segment || "EQ",
    lotSize: item.lotSize || 1,
    addedAt: Date.now(),
  };

  saveWatchlist([newItem, ...current]);
  return { ok: true, message: `Added ${item.symbol} to Watchlist ✓` };
}

/** Helper to add an Option Contract / Strike to watchlist */
export function addOptionToWatchlist(opts: {
  underlying: string;
  strike: number;
  otype: "CE" | "PE";
  expiry: string;
  lotSize?: number;
  exchange?: string;
  token?: string;
  tradingSymbol?: string;
}): { ok: boolean; message: string } {
  const current = getStoredWatchlist();
  const id = `OPT:${opts.underlying.toUpperCase()}:${opts.strike}:${opts.otype}:${opts.expiry}`;

  if (current.some((it) => it.id === id)) {
    return { ok: false, message: `${opts.underlying} ${opts.strike} ${opts.otype} is already in your watchlist` };
  }

  const displayTitle = `${opts.underlying} ${opts.strike} ${opts.otype} (${opts.expiry.slice(5)})`;
  const isCrypto = opts.underlying.endsWith("USD");

  const newItem: WatchlistItem = {
    id,
    kind: "OPTION",
    symbol: displayTitle,
    tradingSymbol: opts.tradingSymbol,
    name: `${opts.underlying} ${opts.strike} ${opts.otype === "CE" ? "CALL" : "PUT"} Option`,
    exchange: isCrypto ? "DELTA" : opts.exchange || "NSE",
    segment: isCrypto ? "CRYPTO" : "OPT",
    lotSize: opts.lotSize || 1,
    underlying: opts.underlying.toUpperCase(),
    strike: opts.strike,
    otype: opts.otype,
    expiry: opts.expiry,
    brokerToken: opts.token,
    addedAt: Date.now(),
  };

  saveWatchlist([newItem, ...current]);
  return { ok: true, message: `Added ${opts.underlying} ${opts.strike} ${opts.otype} to Watchlist ✓` };
}

/** Remove from watchlist */
export function removeFromWatchlist(id: string): void {
  const current = getStoredWatchlist();
  const next = current.filter((it) => it.id !== id);
  saveWatchlist(next);
}
