import type { Instrument } from "@/db/schema";
import type { Quote } from "./market";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const YAHOO_BASE = "https://query1.finance.yahoo.com";
const quoteCache = new Map<string, { quote: Quote; expires: number }>();
let authCache: { cookie: string; crumb: string; expires: number } | null = null;
let authPromise: Promise<{ cookie: string; crumb: string } | null> | null = null;

export interface YahooQuote extends Quote {
  source: "yahoo" | "simulated";
  yahooSymbol: string;
  delayedMinutes: number;
  marketState?: string;
  currency?: string;
}

type YahooRow = {
  symbol?: string;
  regularMarketPrice?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketPreviousClose?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  marketState?: string;
  currency?: string;
};

function firstCookie(setCookie: string | null): string {
  if (!setCookie) return "";
  // Node's Headers may combine multiple Set-Cookie values with commas. We only
  // need the first name=value pair; A3 is the current Yahoo auth cookie.
  const matches = setCookie.match(/(?:^|,\s*)([A-Za-z0-9_]+=[^;,]+)/g) ?? [];
  const preferred = matches.find((x) => /A3=/.test(x)) ?? matches[0] ?? "";
  return preferred.replace(/^,\s*/, "").split(";")[0];
}

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*", ...headers }, cache: "no-store", signal: ctrl.signal });
    return { res, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function yahooAuth(): Promise<{ cookie: string; crumb: string } | null> {
  if (authCache && authCache.expires > Date.now()) return authCache;
  if (authPromise) return authPromise;
  authPromise = (async () => {
    try {
      // fc.yahoo.com intentionally returns 404 in many regions but still sets
      // the A3 cookie needed by the finance query service.
      const seed = await fetchText("https://fc.yahoo.com");
      let cookie = firstCookie(seed.res.headers.get("set-cookie"));
      if (!cookie) cookie = firstCookie((await fetchText(`${YAHOO_BASE}/v1/test/getcrumb`)).res.headers.get("set-cookie"));
      const crumbRes = await fetchText(`${YAHOO_BASE}/v1/test/getcrumb`, cookie ? { Cookie: cookie } : {});
      const crumb = crumbRes.res.ok ? crumbRes.text.trim() : "";
      if (!crumb) return null;
      authCache = { cookie, crumb, expires: Date.now() + 25 * 60 * 1000 };
      return { cookie, crumb };
    } catch {
      return null;
    } finally {
      authPromise = null;
    }
  })();
  return authPromise;
}

/** Yahoo Finance symbol mapping for the app's Indian master symbols. */
export function yahooSymbolForInstrument(inst: Pick<Instrument, "symbol" | "exchange" | "segment">): string | null {
  const index: Record<string, string> = {
    NIFTY: "^NSEI",
    BANKNIFTY: "^NSEBANK",
    FINNIFTY: "^CNXFINANCE",
    MIDCPNIFTY: "^NSEMDCP50",
    NIFTYNXT50: "^NSMID50",
    SENSEX: "^BSESN",
    BANKEX: "^BSEBANK",
    INDIAVIX: "^INDIAVIX",
  };
  if (index[inst.symbol]) return index[inst.symbol];
  // MCX contracts are INR-denominated (Yahoo's GC=F / CL=F are USD) — use the
  // broker live feed or simulator instead of showing a wrong-currency price.
  if (inst.exchange === "MCX") return null;
  if (inst.symbol === "USDINR") return "INR=X";
  if (inst.symbol === "EURINR") return "EURINR=X";
  if (inst.symbol === "GBPINR") return "GBPINR=X";
  if (inst.exchange === "CDS") return null; // JPYINR is quoted per 100 JPY on NSE
  if (inst.exchange === "NSE") return `${inst.symbol}.NS`;
  if (inst.exchange === "BSE") return `${inst.symbol}.BO`;
  // Yahoo does not provide every MCX/CDS contract in INR. Keep the app's
  // simulator for unsupported contracts rather than showing a false price.
  return null;
}

function fromYahoo(row: YahooRow, internalSymbol: string, yahooSymbol: string): YahooQuote | null {
  const ltp = Number(row.regularMarketPrice);
  if (!Number.isFinite(ltp) || ltp <= 0) return null;
  const prev = Number(row.regularMarketPreviousClose) || ltp - (Number(row.regularMarketChange) || 0);
  const change = Number(row.regularMarketChange);
  const changePct = Number(row.regularMarketChangePercent);
  return {
    symbol: internalSymbol,
    yahooSymbol,
    ltp,
    open: Number(row.regularMarketOpen) || ltp,
    high: Number(row.regularMarketDayHigh) || ltp,
    low: Number(row.regularMarketDayLow) || ltp,
    prevClose: prev,
    change: Number.isFinite(change) ? change : ltp - prev,
    changePct: Number.isFinite(changePct) ? changePct : prev ? ((ltp - prev) / prev) * 100 : 0,
    volume: Number(row.regularMarketVolume) || 0,
    ts: (Number(row.regularMarketTime) || Math.floor(Date.now() / 1000)) * 1000,
    source: "yahoo",
    delayedMinutes: 15,
    marketState: row.marketState,
    currency: row.currency,
  };
}

/** Batch Yahoo quote request. Cache is intentionally short for a quote feed. */
export async function yahooQuotes(instruments: Instrument[]): Promise<Record<string, YahooQuote>> {
  const wanted = instruments
    .map((inst) => ({ inst, yahoo: yahooSymbolForInstrument(inst) }))
    .filter((x): x is { inst: Instrument; yahoo: string } => !!x.yahoo);
  const now = Date.now();
  const result: Record<string, YahooQuote> = {};
  const missing = wanted.filter(({ inst }) => {
    const hit = quoteCache.get(inst.symbol);
    if (hit && hit.expires > now) {
      result[inst.symbol] = hit.quote as YahooQuote;
      return false;
    }
    return true;
  });
  if (!missing.length) return result;

  const auth = await yahooAuth();
  if (!auth) return result;
  try {
    // Keep each URL small enough for Stock Finder's all-symbol view.
    for (let start = 0; start < missing.length; start += 100) {
      const chunk = missing.slice(start, start + 100);
      const params = new URLSearchParams({ symbols: chunk.map((x) => x.yahoo).join(","), crumb: auth.crumb });
      const { res, text } = await fetchText(`${YAHOO_BASE}/v7/finance/quote?${params.toString()}`, { Cookie: auth.cookie });
      if (res.status === 401) {
        authCache = null;
        return result;
      }
      if (!res.ok) continue;
      const body = JSON.parse(text) as { quoteResponse?: { result?: YahooRow[] } };
      const byYahoo = new Map((body.quoteResponse?.result ?? []).map((x) => [x.symbol, x]));
      for (const { inst, yahoo } of chunk) {
        const q = fromYahoo(byYahoo.get(yahoo) ?? {}, inst.symbol, yahoo);
        if (q) {
          result[inst.symbol] = q;
          quoteCache.set(inst.symbol, { quote: q, expires: now + 3000 });
        }
      }
    }
  } catch {
    // Caller merges simulator fallback for an unavailable/blocked Yahoo call.
  }
  return result;
}

export function yahooStatus(quote: Quote): quote is YahooQuote {
  return (quote as Partial<YahooQuote>).source === "yahoo";
}
