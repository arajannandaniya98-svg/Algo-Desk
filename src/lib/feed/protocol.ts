/**
 * Broker market-feed binary protocols (pure functions, no runtime imports so
 * they can be unit-tested with plain Node). All packets are Little Endian.
 *
 *  Dhan v2      wss://api-feed.dhan.co  — header(8) + payload, float32 prices
 *  Angel One    wss://smartapisocket.angelone.in/smart-stream — int64 prices in paise
 */
export interface RawTick {
  kind: "tick" | "index" | "quote" | "full" | "oi" | "prevclose" | "disconnect";
  segment: string;
  token: string;
  ltp?: number;
  ltq?: number;
  ltt?: number;
  atp?: number;
  volume?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  prevClose?: number;
  prevOi?: number;
  oi?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  exchTs?: number;
  seq?: number;
  reason?: number;
}

// ---------------- Dhan ----------------
export const DHAN_SEGMENTS: Record<number, string> = { 0: "IDX_I", 1: "NSE_EQ", 2: "NSE_FNO", 3: "NSE_CURRENCY", 4: "BSE_EQ", 5: "MCX_COMM", 7: "BSE_CURRENCY", 8: "BSE_FNO" };
export const DHAN_CODES = { disconnect: 12, ticker: 15, unticker: 16, quote: 17, unquote: 18, full: 21, unfull: 22 } as const;
const DHAN_PACKET_SIZE: Record<number, number> = { 1: 16, 2: 16, 4: 50, 5: 12, 6: 16, 7: 8, 8: 162, 50: 10 };

const round = (n: number, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Parses one websocket message (may contain one or more packets). */
export function parseDhan(input: Uint8Array): RawTick[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const out: RawTick[] = [];
  let o = 0;
  while (o + 8 <= input.byteLength) {
    const code = view.getUint8(o);
    const declared = view.getInt16(o + 1, true);
    const segment = DHAN_SEGMENTS[view.getUint8(o + 3)] ?? String(view.getUint8(o + 3));
    const token = String(view.getInt32(o + 4, true));
    const size = DHAN_PACKET_SIZE[code] ?? (declared >= 8 ? declared : input.byteLength - o);
    if (o + size > input.byteLength) break;
    const dp = segment.endsWith("CURRENCY") ? 4 : 2;
    const f32 = (at: number) => round(view.getFloat32(o + at, true), dp);
    const i32 = (at: number) => view.getInt32(o + at, true);
    const i16 = (at: number) => view.getInt16(o + at, true);
    switch (code) {
      case 1:
      case 2:
        out.push({ kind: code === 1 ? "index" : "tick", segment, token, ltp: f32(8), ltt: i32(12) });
        break;
      case 4:
        out.push({ kind: "quote", segment, token, ltp: f32(8), ltq: i16(12), ltt: i32(14), atp: f32(18), volume: i32(22), totalSellQty: i32(26), totalBuyQty: i32(30), open: f32(34), close: f32(38), high: f32(42), low: f32(46) });
        break;
      case 5:
        out.push({ kind: "oi", segment, token, oi: i32(8) });
        break;
      case 6:
        out.push({ kind: "prevclose", segment, token, prevClose: f32(8), prevOi: i32(12) });
        break;
      case 8:
        out.push({
          kind: "full",
          segment,
          token,
          ltp: f32(8),
          ltq: i16(12),
          ltt: i32(14),
          atp: f32(18),
          volume: i32(22),
          totalSellQty: i32(26),
          totalBuyQty: i32(30),
          oi: i32(34),
          open: f32(46),
          close: f32(50),
          high: f32(54),
          low: f32(58),
          bidQty: i32(62),
          askQty: i32(66),
          bid: f32(74),
          ask: f32(78),
        });
        break;
      case 50:
        out.push({ kind: "disconnect", segment, token, reason: i16(8) });
        break;
      default:
        break; // market status / unknown packets are ignored
    }
    o += size;
  }
  return out;
}

/** Subscription JSON (max 100 instruments per message). */
export function dhanRequests(requestCode: number, list: { segment: string; token: string }[]): string[] {
  const msgs: string[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    msgs.push(JSON.stringify({ RequestCode: requestCode, InstrumentCount: chunk.length, InstrumentList: chunk.map((x) => ({ ExchangeSegment: x.segment, SecurityId: x.token })) }));
  }
  return msgs;
}

/** Cash/index → Quote packet (OHLC, volume) · derivatives → Full packet (adds OI + best bid/ask). */
export const dhanModeFor = (segment: string): "quote" | "full" => (segment === "IDX_I" || segment.endsWith("_EQ") ? "quote" : "full");

// ---------------- Angel One SmartStream 2.0 ----------------
/** exchangeType: 1 nse_cm · 2 nse_fo · 3 bse_cm · 4 bse_fo · 5 mcx_fo · 7 ncx_fo · 13 cde_fo */
export function parseAngel(input: Uint8Array): RawTick | null {
  if (input.byteLength < 51) return null;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const mode = view.getUint8(0);
  const exch = view.getUint8(1);
  let token = "";
  for (let i = 2; i < 27; i++) {
    const c = view.getUint8(i);
    if (c === 0) break;
    token += String.fromCharCode(c);
  }
  const div = exch === 13 ? 1e7 : 100;
  const dp = exch === 13 ? 4 : 2;
  const i64 = (at: number) => Number(view.getBigInt64(at, true));
  const px = (at: number) => round(i64(at) / div, dp);
  const t: RawTick = { kind: mode === 1 ? "tick" : mode === 2 ? "quote" : "full", segment: String(exch), token, seq: i64(27), exchTs: i64(35), ltp: px(43) };
  if (input.byteLength >= 123) {
    t.ltq = i64(51);
    t.atp = px(59);
    t.volume = i64(67);
    t.totalBuyQty = view.getFloat64(75, true);
    t.totalSellQty = view.getFloat64(83, true);
    t.open = px(91);
    t.high = px(99);
    t.low = px(107);
    t.prevClose = px(115);
  }
  if (input.byteLength >= 379) {
    t.oi = i64(131);
    for (let k = 0; k < 10; k++) {
      const b = 147 + k * 20;
      const isBuy = view.getInt16(b, true) === 1;
      const qty = i64(b + 2);
      const price = round(i64(b + 10) / div, dp);
      if (price <= 0) continue;
      if (isBuy && t.bid == null) {
        t.bid = price;
        t.bidQty = qty;
      }
      if (!isBuy && t.ask == null) {
        t.ask = price;
        t.askQty = qty;
      }
    }
  }
  return t;
}

/** action 1 = subscribe, 0 = unsubscribe · mode 1 LTP, 2 Quote, 3 SnapQuote */
export function angelRequest(action: 0 | 1, mode: 1 | 2 | 3, list: { segment: string; token: string }[], correlationID = "algodesk01"): string {
  const groups = new Map<number, string[]>();
  for (const x of list) {
    const k = Number(x.segment);
    groups.set(k, [...(groups.get(k) ?? []), x.token]);
  }
  return JSON.stringify({ correlationID, action, params: { mode, tokenList: [...groups].map(([exchangeType, tokens]) => ({ exchangeType, tokens })) } });
}
