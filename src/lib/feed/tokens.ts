import { db, pool } from "@/db";
import { instrumentTokens, instruments } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { FeedInstrument, FeedProvider } from "./types";

type Real = "dhan" | "angelone";

/** Built-in index tokens (used before the scrip master is synced). Verified against both masters. */
export const INDEX_TOKENS: Record<Real, Record<string, { segment: string; token: string; exchange: string }>> = {
  dhan: {
    NIFTY: { segment: "IDX_I", token: "13", exchange: "NSE" },
    BANKNIFTY: { segment: "IDX_I", token: "25", exchange: "NSE" },
    FINNIFTY: { segment: "IDX_I", token: "27", exchange: "NSE" },
    MIDCPNIFTY: { segment: "IDX_I", token: "442", exchange: "NSE" },
    NIFTYNXT50: { segment: "IDX_I", token: "38", exchange: "NSE" },
    INDIAVIX: { segment: "IDX_I", token: "21", exchange: "NSE" },
    SENSEX: { segment: "IDX_I", token: "51", exchange: "BSE" },
    BANKEX: { segment: "IDX_I", token: "69", exchange: "BSE" },
  },
  angelone: {
    NIFTY: { segment: "1", token: "99926000", exchange: "NSE" },
    BANKNIFTY: { segment: "1", token: "99926009", exchange: "NSE" },
    FINNIFTY: { segment: "1", token: "99926037", exchange: "NSE" },
    MIDCPNIFTY: { segment: "1", token: "99926074", exchange: "NSE" },
    NIFTYNXT50: { segment: "1", token: "99926013", exchange: "NSE" },
    INDIAVIX: { segment: "1", token: "99926017", exchange: "NSE" },
    SENSEX: { segment: "3", token: "99919000", exchange: "BSE" },
    BANKEX: { segment: "3", token: "99919012", exchange: "BSE" },
  },
};

export const feedKey = (p: FeedProvider, segment: string, token: string) => `${p}:${segment}:${token}`;
const isDeltaOption = (s: string) => /^[CP]-[A-Z0-9]+-\d/.test(s);
const mk = (provider: FeedProvider, segment: string, token: string, symbol: string, extra: Partial<FeedInstrument> = {}): FeedInstrument => ({
  key: feedKey(provider, segment, token),
  provider,
  segment,
  token,
  symbol,
  ...extra,
});

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());

type Entry = { v: FeedInstrument | null; at: number };
const g = globalThis as unknown as { __algodeskTokCache?: Map<string, Entry> };
const cache: Map<string, Entry> = (g.__algodeskTokCache ??= new Map());
export const clearTokenCache = () => cache.clear();

export interface ResolveQuery {
  symbol: string;
  underlying?: string;
  instrumentType: string; // EQ | INDEX | FUT | CE | PE
  strike?: number | null;
  expiry?: string;
  exchange?: string;
}

/** Maps an app instrument / contract to the broker feed token (DB scrip master → built-ins). */
export async function resolveFeedInstrument(provider: FeedProvider, q: ResolveQuery): Promise<FeedInstrument | null> {
  const type = q.instrumentType || "EQ";
  if (provider === "demo") {
    if (type === "CE" || type === "PE") return null;
    const s = type === "FUT" && q.underlying ? q.underlying : q.symbol;
    return mk("demo", "DEMO", s, s);
  }
  if (provider === "delta") {
    // crypto: the Delta symbol itself is the token (perp BTCUSD / option C-BTC-86200-061026)
    if ((type === "CE" || type === "PE") && !isDeltaOption(q.symbol)) return null;
    return mk("delta", "DELTA", q.symbol, q.symbol, { exchange: "DELTA", tradingSymbol: q.symbol });
  }
  const ck = [provider, q.symbol, q.underlying ?? "", type, q.strike ?? "", q.expiry ?? "", q.exchange ?? ""].join("|");
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < (hit.v ? 600_000 : 60_000)) return hit.v;

  let v: FeedInstrument | null = null;
  const exch = q.exchange || "NSE";
  try {
    if (type === "EQ" || type === "INDEX") {
      const r = await pool.query(
        "select segment, token, exchange, trading_symbol from instrument_tokens where provider = $1 and symbol = $2 and instrument_type in ('EQ','INDEX') order by (instrument_type = 'INDEX') desc, (exchange = $3) desc limit 1",
        [provider, q.symbol, exch],
      );
      const row = r.rows[0];
      if (row) v = mk(provider, row.segment, row.token, q.symbol, { exchange: row.exchange, tradingSymbol: row.trading_symbol });
      else {
        const b = provider === "dhan" || provider === "angelone" ? INDEX_TOKENS[provider][q.symbol] : undefined;
        if (b) v = mk(provider, b.segment, b.token, q.symbol, { exchange: b.exchange, tradingSymbol: q.symbol });
      }
    } else if (type === "FUT") {
      const r = await pool.query(
        "select segment, token, exchange, trading_symbol, lot_size from instrument_tokens where provider = $1 and symbol = $2 and instrument_type = 'FUT' and expiry >= $3 and ($4 = '' or expiry = $4) order by (exchange = $5) desc, expiry asc limit 1",
        [provider, q.underlying || q.symbol, today(), q.expiry ?? "", exch],
      );
      const row = r.rows[0];
      if (row) v = mk(provider, row.segment, row.token, row.trading_symbol || q.symbol, { exchange: row.exchange, tradingSymbol: row.trading_symbol, lotSize: row.lot_size });
    } else if ((type === "CE" || type === "PE") && q.strike && q.expiry) {
      const r = await pool.query(
        "select segment, token, exchange, trading_symbol, lot_size from instrument_tokens where provider = $1 and symbol = $2 and instrument_type = $3 and expiry = $4 and abs(strike - $5) < 0.001 order by (exchange = $6) desc limit 1",
        [provider, q.underlying || q.symbol, type, q.expiry, q.strike, exch],
      );
      const row = r.rows[0];
      if (row) v = mk(provider, row.segment, row.token, row.trading_symbol || q.symbol, { exchange: row.exchange, tradingSymbol: row.trading_symbol, lotSize: row.lot_size });
    }
  } catch {
    v = null;
  }
  if (cache.size > 20_000) cache.clear();
  cache.set(ck, { v, at: Date.now() });
  return v;
}

/** Real exchange expiries for an underlying (requires a synced scrip master). */
export async function realExpiries(provider: Real, underlying: string, exchange: string): Promise<string[]> {
  try {
    const r = await pool.query(
      "select distinct expiry from instrument_tokens where provider = $1 and symbol = $2 and exchange = $3 and instrument_type in ('CE','PE') and expiry >= $4 order by expiry limit 12",
      [provider, underlying, exchange, today()],
    );
    return r.rows.map((x: { expiry: string }) => x.expiry);
  } catch {
    return [];
  }
}

/** All option contracts (strike → CE/PE) for one expiry. */
export async function chainInstruments(provider: Real, underlying: string, expiry: string, exchange: string) {
  const map = new Map<number, { CE?: FeedInstrument; PE?: FeedInstrument }>();
  let lotSize = 0;
  try {
    const r = await pool.query(
      "select segment, token, strike, instrument_type, trading_symbol, lot_size from instrument_tokens where provider = $1 and symbol = $2 and exchange = $3 and expiry = $4 and instrument_type in ('CE','PE')",
      [provider, underlying, exchange, expiry],
    );
    for (const row of r.rows) {
      const k = Number(row.strike);
      const e = map.get(k) ?? {};
      e[row.instrument_type as "CE" | "PE"] = mk(provider, row.segment, row.token, row.trading_symbol, { exchange, tradingSymbol: row.trading_symbol, lotSize: row.lot_size });
      map.set(k, e);
      lotSize = row.lot_size || lotSize;
    }
  } catch {
    /* table missing */
  }
  return { map, lotSize };
}

export async function tokenStats(): Promise<Record<string, number>> {
  try {
    const r = await pool.query("select provider, count(*)::int as n from instrument_tokens group by provider");
    return Object.fromEntries(r.rows.map((x: { provider: string; n: number }) => [x.provider, x.n]));
  } catch {
    return {};
  }
}

// ---------------- scrip master sync ----------------
const ANGEL_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const DHAN_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const BSE_INDEX_DERIV = new Set(["SENSEX", "BANKEX"]);
type Row = typeof instrumentTokens.$inferInsert;

async function download(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { "User-Agent": "Mozilla/5.0 AlgoDesk" } });
    if (!res.ok) throw new Error(`Scrip master download failed (HTTP ${res.status})`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Downloads the broker's instrument master and stores tokens for: all NSE
 * equities, indices, and FUT/OPT contracts (next ~100 days) of every
 * underlying in the app's instrument list.
 */
export async function syncScripMaster(provider: Real) {
  const t0 = Date.now();
  const known = new Set((await db.select({ symbol: instruments.symbol }).from(instruments)).map((r) => r.symbol));
  const from = today();
  const h = new Date();
  h.setDate(h.getDate() + 100);
  const horizon = ymd(h);
  const keep = (e: string) => !!e && e >= from && e <= horizon;
  const rows: Row[] = [];

  if (provider === "angelone") {
    const data = (await (await download(ANGEL_URL)).json()) as { token: string; symbol: string; name: string; expiry: string; strike: string; lotsize: string; instrumenttype: string; exch_seg: string }[];
    for (const r of data) {
      const seg = r.exch_seg;
      const it = r.instrumenttype;
      if (seg === "NSE" || seg === "BSE") {
        if (it === "AMXIDX") {
          const sym = r.name === "INDIA VIX" ? "INDIAVIX" : r.name;
          if (known.has(sym)) rows.push({ provider, symbol: sym, tradingSymbol: r.symbol, exchange: seg, segment: seg === "NSE" ? "1" : "3", token: r.token, instrumentType: "INDEX", lotSize: 1 });
        } else if (!it && seg === "NSE" && r.symbol.endsWith("-EQ")) {
          rows.push({ provider, symbol: r.name, tradingSymbol: r.symbol, exchange: "NSE", segment: "1", token: r.token, instrumentType: "EQ", lotSize: 1 });
        }
        continue;
      }
      const isOpt = it === "OPTIDX" || it === "OPTSTK";
      const isFut = it === "FUTIDX" || it === "FUTSTK" || it === "FUTCOM" || it === "FUTCUR";
      if ((!isOpt && !isFut) || !known.has(r.name) || !["NFO", "BFO", "MCX", "CDS"].includes(seg)) continue;
      if (seg === "BFO" && !BSE_INDEX_DERIV.has(r.name)) continue;
      const exp = r.expiry?.length === 9 ? `${r.expiry.slice(5)}-${MONTHS[r.expiry.slice(2, 5)] ?? "01"}-${r.expiry.slice(0, 2)}` : "";
      if (!keep(exp)) continue;
      rows.push({
        provider,
        symbol: r.name,
        tradingSymbol: r.symbol,
        exchange: seg === "NFO" ? "NSE" : seg === "BFO" ? "BSE" : seg,
        segment: seg === "NFO" ? "2" : seg === "BFO" ? "4" : seg === "MCX" ? "5" : "13",
        token: r.token,
        instrumentType: isFut ? "FUT" : r.symbol.endsWith("CE") ? "CE" : "PE",
        expiry: exp,
        strike: isOpt ? Number(r.strike) / 100 : 0,
        lotSize: parseInt(r.lotsize, 10) || 1,
      });
    }
  } else {
    const lines = (await (await download(DHAN_URL)).text()).split(/\r?\n/);
    const head = splitCsv(lines[0] ?? "");
    const ix = (n: string) => head.indexOf(n);
    const [cE, cS, cId, cI, cT, cL, cX, cK, cO, cSe] = ["SEM_EXM_EXCH_ID", "SEM_SEGMENT", "SEM_SMST_SECURITY_ID", "SEM_INSTRUMENT_NAME", "SEM_TRADING_SYMBOL", "SEM_LOT_UNITS", "SEM_EXPIRY_DATE", "SEM_STRIKE_PRICE", "SEM_OPTION_TYPE", "SEM_SERIES"].map(ix);
    if ([cE, cS, cId, cI, cT].some((c) => c < 0)) throw new Error("Unexpected Dhan scrip master format");
    for (let n = 1; n < lines.length; n++) {
      if (!lines[n]) continue;
      const c = splitCsv(lines[n]);
      const exch = c[cE];
      const segc = c[cS];
      const instr = c[cI];
      const ts = c[cT] ?? "";
      const id = c[cId];
      if (instr === "INDEX") {
        const sym = ts === "INDIA VIX" ? "INDIAVIX" : ts;
        if (known.has(sym)) rows.push({ provider, symbol: sym, tradingSymbol: ts, exchange: exch, segment: "IDX_I", token: id, instrumentType: "INDEX", lotSize: 1 });
        continue;
      }
      if (instr === "EQUITY") {
        if (exch === "NSE" && segc === "E" && c[cSe] === "EQ") rows.push({ provider, symbol: ts, tradingSymbol: ts, exchange: "NSE", segment: "NSE_EQ", token: id, instrumentType: "EQ", lotSize: 1 });
        continue;
      }
      const isOpt = instr === "OPTIDX" || instr === "OPTSTK";
      const isFut = instr === "FUTIDX" || instr === "FUTSTK" || instr === "FUTCOM" || instr === "FUTCUR";
      if (!isOpt && !isFut) continue;
      const u = ts.split("-")[0];
      if (!known.has(u)) continue;
      let segment = "";
      if (exch === "NSE" && segc === "D") segment = "NSE_FNO";
      else if (exch === "BSE" && segc === "D" && BSE_INDEX_DERIV.has(u)) segment = "BSE_FNO";
      else if (exch === "MCX" && segc === "M") segment = "MCX_COMM";
      else if (exch === "NSE" && segc === "C") segment = "NSE_CURRENCY";
      if (!segment) continue;
      const exp = (c[cX] ?? "").slice(0, 10);
      if (!keep(exp)) continue;
      const opt = c[cO];
      if (isOpt && opt !== "CE" && opt !== "PE") continue;
      rows.push({
        provider,
        symbol: u,
        tradingSymbol: ts,
        exchange: exch,
        segment,
        token: id,
        instrumentType: isFut ? "FUT" : opt,
        expiry: exp,
        strike: isOpt ? Number(c[cK]) || 0 : 0,
        lotSize: Math.round(Number(c[cL])) || 1,
      });
    }
  }

  if (!rows.length) throw new Error("No instruments parsed from the scrip master");
  await db.transaction(async (tx) => {
    await tx.delete(instrumentTokens).where(eq(instrumentTokens.provider, provider));
    for (let i = 0; i < rows.length; i += 1000) await tx.insert(instrumentTokens).values(rows.slice(i, i + 1000));
  });
  clearTokenCache();
  await pool.query(
    `insert into app_settings (id, token_sync) values (1, jsonb_build_object($1::text, jsonb_build_object('at', now()::text, 'rows', $2::int)))
     on conflict (id) do update set token_sync = coalesce(app_settings.token_sync, '{}'::jsonb) || excluded.token_sync`,
    [provider, rows.length],
  );
  return { provider, rows: rows.length, ms: Date.now() - t0 };
}
