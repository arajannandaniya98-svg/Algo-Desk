/**
 * Technical indicator engine — pure functions, no imports.
 * Produces a combined BUY / SELL / HOLD signal from classic indicators
 * (Supertrend, EMA cross, MACD, RSI, ADX, Bollinger, Stochastic, VWAP, Volume).
 */
export interface Candle {
  t: number; // epoch ms (candle open time)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Vote = "BUY" | "SELL" | "HOLD";

export interface IndicatorResult {
  id: string;
  name: string;
  value: string;
  vote: Vote;
  weight: number;
  detail: string;
}

export interface SignalLevels {
  atr: number;
  stopLoss: number;
  target: number;
  support: number;
  resistance: number;
  riskReward: number;
}

export interface SignalResult {
  signal: Vote;
  strength: "STRONG" | "MODERATE" | "WEAK";
  score: number; // -100 (strong sell) … +100 (strong buy)
  buy: number;
  sell: number;
  hold: number;
  indicators: IndicatorResult[];
  levels: SignalLevels;
  trend: "UP" | "DOWN" | "SIDEWAYS";
  close: number;
  changePct: number;
  candles: number;
  rsiCrossover?: {
    type: "BULLISH_OVERSOLD_EXIT" | "BEARISH_OVERBOUGHT_EXIT" | "BULLISH_50_CROSS" | "BEARISH_50_CROSS" | "NONE";
    signal: Vote;
    detail: string;
    prevRsi: number;
    currRsi: number;
  };
  emaCrossover?: {
    side: "CALL" | "PUT" | "NEUTRAL";
    signal: Vote;
    barsSinceCross: number; // 0 = running candle, 1 = 1 candle ago, 2 = 2 candles ago
    runningCross: boolean;
    oneCandleCross: boolean;
    twoCandleCross: boolean;
    ema9: number;
    ema21: number;
    detail: string;
  };
  orbBreakout?: {
    status: "BULLISH_BREAKOUT" | "BEARISH_BREAKDOWN" | "INSIDE_RANGE";
    signal: Vote;
    orbHigh: number;
    orbLow: number;
    orbMid: number;
    target: number;
    stopLoss: number;
    detail: string;
  };
}

export interface IndicatorConfig {
  supertrendPeriod: number; // default 10
  supertrendMult: number;   // default 3
  emaFast: number;          // default 9
  emaSlow: number;          // default 21
  macdFast: number;         // default 12
  macdSlow: number;         // default 26
  macdSignal: number;       // default 9
  rsiPeriod: number;        // default 14
  rsiOverbought: number;    // default 70
  rsiOversold: number;      // default 30
  adxPeriod: number;        // default 14
  adxThreshold: number;     // default 20
  bollingerPeriod: number;  // default 20
  bollingerMult: number;    // default 2
  stochPeriod: number;      // default 14
  stochSmooth: number;      // default 3
  ema50Period: number;      // default 50
  volumePeriod: number;     // default 20
}

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  supertrendPeriod: 10,
  supertrendMult: 3,
  emaFast: 9,
  emaSlow: 21,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  adxPeriod: 14,
  adxThreshold: 20,
  bollingerPeriod: 20,
  bollingerMult: 2,
  stochPeriod: 14,
  stochSmooth: 3,
  ema50Period: 50,
  volumePeriod: 20,
};

type Series = (number | null)[];
const last = (s: Series): number | null => (s.length ? s[s.length - 1] : null);
const prev = (s: Series, back = 1): number | null => (s.length > back ? s[s.length - 1 - back] : null);
const r2 = (n: number, d = 2) => +n.toFixed(d);

// ---------- moving averages ----------
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  let e = acc / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder's smoothing (used by RSI / ATR / ADX) */
function rma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  let v = acc / period;
  out[period - 1] = v;
  for (let i = period; i < values.length; i++) {
    v = (v * (period - 1) + values[i]) / period;
    out[i] = v;
  }
  return out;
}

// ---------- oscillators ----------
export function rsi(closes: number[], period = 14): Series {
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  return closes.map((_, i) => {
    const g = ag[i];
    const l = al[i];
    if (g == null || l == null) return null;
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  });
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: Series = closes.map((_, i) => (ef[i] != null && es[i] != null ? (ef[i] as number) - (es[i] as number) : null));
  const defined = line.filter((x): x is number => x != null);
  const sig = ema(defined, signal);
  const offset = line.length - defined.length;
  const signalLine: Series = new Array(closes.length).fill(null);
  sig.forEach((v, i) => {
    signalLine[i + offset] = v;
  });
  const hist: Series = line.map((v, i) => (v != null && signalLine[i] != null ? v - (signalLine[i] as number) : null));
  return { line, signal: signalLine, hist };
}

export function trueRange(c: Candle[]): number[] {
  return c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
}

export const atr = (c: Candle[], period = 14): Series => rma(trueRange(c), period);

export function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: Series = new Array(closes.length).fill(null);
  const lower: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i];
    if (m == null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

export function supertrend(c: Candle[], period = 10, mult = 3) {
  const a = atr(c, period);
  const trend: (1 | -1 | null)[] = new Array(c.length).fill(null);
  const line: Series = new Array(c.length).fill(null);
  let upper = 0;
  let lower = 0;
  let dir: 1 | -1 = 1;
  for (let i = 0; i < c.length; i++) {
    const av = a[i];
    if (av == null) continue;
    const mid = (c[i].h + c[i].l) / 2;
    const bu = mid + mult * av;
    const bl = mid - mult * av;
    const pc = c[i - 1]?.c ?? c[i].c;
    upper = bu < upper || pc > upper ? bu : upper;
    lower = bl > lower || pc < lower ? bl : lower;
    if (trend[i - 1] == null) dir = c[i].c >= mid ? 1 : -1;
    else if (dir === 1 && c[i].c < lower) dir = -1;
    else if (dir === -1 && c[i].c > upper) dir = 1;
    trend[i] = dir;
    line[i] = dir === 1 ? lower : upper;
  }
  return { trend, line };
}

export function adx(c: Candle[], period = 14) {
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = rma(trueRange(c), period);
  const pd = rma(plusDM, period);
  const md = rma(minusDM, period);
  const plusDI: Series = c.map((_, i) => (tr[i] && pd[i] != null ? (100 * (pd[i] as number)) / (tr[i] as number) : null));
  const minusDI: Series = c.map((_, i) => (tr[i] && md[i] != null ? (100 * (md[i] as number)) / (tr[i] as number) : null));
  const dx: number[] = [];
  const dxIndex: number[] = [];
  c.forEach((_, i) => {
    const p = plusDI[i];
    const m = minusDI[i];
    if (p == null || m == null || p + m === 0) return;
    dx.push((100 * Math.abs(p - m)) / (p + m));
    dxIndex.push(i);
  });
  const adxVals = rma(dx, period);
  const out: Series = new Array(c.length).fill(null);
  dxIndex.forEach((idx, i) => {
    out[idx] = adxVals[i];
  });
  return { adx: out, plusDI, minusDI };
}

export function stochastic(c: Candle[], period = 14, smoothD = 3) {
  const k: Series = new Array(c.length).fill(null);
  for (let i = period - 1; i < c.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, c[j].h);
      ll = Math.min(ll, c[j].l);
    }
    k[i] = hh === ll ? 50 : ((c[i].c - ll) / (hh - ll)) * 100;
  }
  const defined = k.filter((x): x is number => x != null);
  const dRaw = sma(defined, smoothD);
  const d: Series = new Array(c.length).fill(null);
  const off = k.length - defined.length;
  dRaw.forEach((v, i) => {
    d[i + off] = v;
  });
  return { k, d };
}

/** Session VWAP — resets each trading day (intraday candles only). */
export function vwap(c: Candle[]): Series {
  const out: Series = new Array(c.length).fill(null);
  let day = "";
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < c.length; i++) {
    const d = new Date(c[i].t).toDateString();
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (c[i].h + c[i].l + c[i].c) / 3;
    const v = c[i].v || 1;
    pv += typical * v;
    vol += v;
    out[i] = vol ? pv / vol : null;
  }
  return out;
}

// ---------- combined signal ----------
const voteOf = (buy: boolean, sell: boolean): Vote => (buy ? "BUY" : sell ? "SELL" : "HOLD");

/**
 * Runs every indicator and combines the votes into one BUY / SELL / HOLD call.
 * Weighted score: trend indicators count more than oscillators.
 */
export function analyse(candles: Candle[], customConfig?: Partial<IndicatorConfig>): SignalResult | null {
  const c = candles.filter((x) => Number.isFinite(x.c) && x.c > 0);
  if (c.length < 30) return null;
  const cfg: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, ...(customConfig ?? {}) };
  const closes = c.map((x) => x.c);
  const close = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2] ?? close;
  const ind: IndicatorResult[] = [];

  // 1. Supertrend — primary trend
  const st = supertrend(c, cfg.supertrendPeriod, cfg.supertrendMult);
  const stDir = st.trend[st.trend.length - 1];
  const stPrev = st.trend[st.trend.length - 2];
  const stLine = last(st.line);
  ind.push({
    id: "supertrend",
    name: `Supertrend (${cfg.supertrendPeriod},${cfg.supertrendMult})`,
    value: stLine != null ? r2(stLine).toLocaleString("en-IN") : "—",
    vote: voteOf(stDir === 1, stDir === -1),
    weight: 2,
    detail: stDir === 1 ? (stPrev === -1 ? "Fresh buy flip — price above Supertrend" : "Uptrend — price above Supertrend") : stDir === -1 ? (stPrev === 1 ? "Fresh sell flip — price below Supertrend" : "Downtrend — price below Supertrend") : "Not enough data",
  });

  // 2. EMA 9/21 crossover (Running Candle, -1 Candle, -2 Candle tracking)
  const eFast = ema(closes, cfg.emaFast);
  const eSlow = ema(closes, cfg.emaSlow);
  const e50 = ema(closes, cfg.ema50Period);
  const f = last(eFast);
  const s = last(eSlow);
  const fp = prev(eFast, 1);
  const sp = prev(eSlow, 1);
  const fp2 = prev(eFast, 2);
  const sp2 = prev(eSlow, 2);
  const fp3 = prev(eFast, 3);
  const sp3 = prev(eSlow, 3);

  const crossUp0 = f != null && s != null && fp != null && sp != null && fp <= sp && f > s;
  const crossDn0 = f != null && s != null && fp != null && sp != null && fp >= sp && f < s;
  const crossUp1 = fp != null && sp != null && fp2 != null && sp2 != null && fp2 <= sp2 && fp > sp && f != null && s != null && f > s;
  const crossDn1 = fp != null && sp != null && fp2 != null && sp2 != null && fp2 >= sp2 && fp < sp && f != null && s != null && f < s;
  const crossUp2 = fp2 != null && sp2 != null && fp3 != null && sp3 != null && fp3 <= sp3 && fp2 > sp2 && f != null && s != null && f > s;
  const crossDn2 = fp2 != null && sp2 != null && fp3 != null && sp3 != null && fp3 >= sp3 && fp2 < sp2 && f != null && s != null && f < s;

  let barsSinceCross = 99;
  for (let b = 0; b < Math.min(25, closes.length - 2); b++) {
    const cf = prev(eFast, b);
    const cs = prev(eSlow, b);
    const pf = prev(eFast, b + 1);
    const ps = prev(eSlow, b + 1);
    if (cf != null && cs != null && pf != null && ps != null) {
      if ((pf <= ps && cf > cs) || (pf >= ps && cf < cs)) {
        barsSinceCross = b;
        break;
      }
    }
  }

  const emaCallSide = !!(f && s && f > s);
  const emaPutSide = !!(f && s && f < s);
  const emaCrossInfo = {
    side: (emaCallSide ? "CALL" : emaPutSide ? "PUT" : "NEUTRAL") as "CALL" | "PUT" | "NEUTRAL",
    signal: voteOf(emaCallSide, emaPutSide),
    barsSinceCross,
    runningCross: crossUp0 || crossDn0,
    oneCandleCross: crossUp1 || crossDn1,
    twoCandleCross: crossUp2 || crossDn2,
    ema9: f != null ? r2(f) : 0,
    ema21: s != null ? r2(s) : 0,
    detail: crossUp0
      ? `CALL Entry (Running Candle): EMA ${cfg.emaFast} crossed above EMA ${cfg.emaSlow}`
      : crossDn0
      ? `PUT Entry (Running Candle): EMA ${cfg.emaFast} crossed below EMA ${cfg.emaSlow}`
      : crossUp1
      ? `CALL Entry (-1 Candle Confirm): EMA ${cfg.emaFast} crossed above EMA ${cfg.emaSlow}`
      : crossDn1
      ? `PUT Entry (-1 Candle Confirm): EMA ${cfg.emaFast} crossed below EMA ${cfg.emaSlow}`
      : crossUp2
      ? `CALL Entry (-2 Candle Confirm): EMA ${cfg.emaFast} crossed above EMA ${cfg.emaSlow}`
      : crossDn2
      ? `PUT Entry (-2 Candle Confirm): EMA ${cfg.emaFast} crossed below EMA ${cfg.emaSlow}`
      : emaCallSide
      ? `CALL Side Active (${barsSinceCross} bars since cross)`
      : `PUT Side Active (${barsSinceCross} bars since cross)`,
  };

  ind.push({
    id: "ema",
    name: `EMA ${cfg.emaFast}/${cfg.emaSlow} cross`,
    value: f != null && s != null ? `${r2(f)} / ${r2(s)}` : "—",
    vote: voteOf(emaCallSide, emaPutSide),
    weight: 2,
    detail: emaCrossInfo.detail,
  });

  // 3. MACD
  const m = macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const mh = last(m.hist);
  const mhPrev = prev(m.hist);
  ind.push({
    id: "macd",
    name: `MACD (${cfg.macdFast},${cfg.macdSlow},${cfg.macdSignal})`,
    value: mh != null ? String(r2(mh)) : "—",
    vote: voteOf(!!(mh && mh > 0), !!(mh && mh < 0)),
    weight: 1.5,
    detail: mh == null ? "—" : mh > 0 ? (mhPrev != null && mhPrev <= 0 ? "Histogram turned positive (buy crossover)" : "Momentum positive") : mhPrev != null && mhPrev >= 0 ? "Histogram turned negative (sell crossover)" : "Momentum negative",
  });

  // 4. RSI & RSI Crossover
  const rsiSeries = rsi(closes, cfg.rsiPeriod);
  const rs = last(rsiSeries);
  const rsPrev = prev(rsiSeries);

  let rsiCrossType: "BULLISH_OVERSOLD_EXIT" | "BEARISH_OVERBOUGHT_EXIT" | "BULLISH_50_CROSS" | "BEARISH_50_CROSS" | "NONE" = "NONE";
  let rsiCrossVote: Vote = "HOLD";
  let rsiCrossDetail = "No RSI crossover on current candle";

  if (rs != null && rsPrev != null) {
    if (rsPrev < cfg.rsiOversold && rs >= cfg.rsiOversold) {
      rsiCrossType = "BULLISH_OVERSOLD_EXIT";
      rsiCrossVote = "BUY";
      rsiCrossDetail = `Bullish Reversal: RSI crossed ABOVE oversold ${cfg.rsiOversold} (${r2(rsPrev, 1)} -> ${r2(rs, 1)})`;
    } else if (rsPrev > cfg.rsiOverbought && rs <= cfg.rsiOverbought) {
      rsiCrossType = "BEARISH_OVERBOUGHT_EXIT";
      rsiCrossVote = "SELL";
      rsiCrossDetail = `Bearish Reversal: RSI crossed BELOW overbought ${cfg.rsiOverbought} (${r2(rsPrev, 1)} -> ${r2(rs, 1)})`;
    } else if (rsPrev < 50 && rs >= 50) {
      rsiCrossType = "BULLISH_50_CROSS";
      rsiCrossVote = "BUY";
      rsiCrossDetail = `Bullish Momentum: RSI crossed ABOVE 50 center line (${r2(rsPrev, 1)} -> ${r2(rs, 1)})`;
    } else if (rsPrev > 50 && rs <= 50) {
      rsiCrossType = "BEARISH_50_CROSS";
      rsiCrossVote = "SELL";
      rsiCrossDetail = `Bearish Momentum: RSI crossed BELOW 50 center line (${r2(rsPrev, 1)} -> ${r2(rs, 1)})`;
    }
  }

  ind.push({
    id: "rsi",
    name: `RSI (${cfg.rsiPeriod})`,
    value: rs != null ? String(r2(rs, 1)) : "—",
    vote: rs == null ? "HOLD" : rs < cfg.rsiOversold ? "BUY" : rs > cfg.rsiOverbought ? "SELL" : rs > 55 ? "BUY" : rs < 45 ? "SELL" : "HOLD",
    weight: 1.5,
    detail: rs == null ? "—" : rs < cfg.rsiOversold ? `Oversold (<${cfg.rsiOversold}) — bounce possible` : rs > cfg.rsiOverbought ? `Overbought (>${cfg.rsiOverbought}) — pullback possible` : rs > 55 ? "Bullish momentum zone" : rs < 45 ? "Bearish momentum zone" : "Neutral zone (45-55)",
  });

  ind.push({
    id: "rsi_cross",
    name: "RSI Crossover",
    value: rs != null && rsPrev != null ? `${r2(rs, 1)} (${r2(rsPrev, 1)} prev)` : "—",
    vote: rsiCrossVote,
    weight: 2,
    detail: rsiCrossDetail,
  });

  // 5. ADX — trend strength, direction from DI
  const ad = adx(c, cfg.adxPeriod);
  const adxV = last(ad.adx);
  const pdi = last(ad.plusDI);
  const mdi = last(ad.minusDI);
  const strongTrend = !!(adxV && adxV >= cfg.adxThreshold);
  ind.push({
    id: "adx",
    name: `ADX (${cfg.adxPeriod})`,
    value: adxV != null ? String(r2(adxV, 1)) : "—",
    vote: !strongTrend ? "HOLD" : voteOf(!!(pdi && mdi && pdi > mdi), !!(pdi && mdi && mdi > pdi)),
    weight: 1,
    detail: adxV == null ? "—" : !strongTrend ? `Weak / ranging market (ADX ${r2(adxV, 1)} < ${cfg.adxThreshold})` : `${adxV >= 40 ? "Very strong" : "Strong"} trend · +DI ${r2(pdi ?? 0, 1)} / -DI ${r2(mdi ?? 0, 1)}`,
  });

  // 6. Bollinger Bands
  const bb = bollinger(closes, cfg.bollingerPeriod, cfg.bollingerMult);
  const bu = last(bb.upper);
  const bl = last(bb.lower);
  const bm = last(bb.mid);
  ind.push({
    id: "bb",
    name: `Bollinger (${cfg.bollingerPeriod},${cfg.bollingerMult})`,
    value: bl != null && bu != null ? `${r2(bl)} – ${r2(bu)}` : "—",
    vote: bl != null && bu != null ? (close <= bl ? "BUY" : close >= bu ? "SELL" : bm != null && close > bm ? "BUY" : "SELL") : "HOLD",
    weight: 1,
    detail: bl == null || bu == null ? "—" : close <= bl ? "At/below lower band — oversold" : close >= bu ? "At/above upper band — overbought" : bm != null && close > bm ? "Above mid band" : "Below mid band",
  });

  // 7. Stochastic
  const sto = stochastic(c, cfg.stochPeriod, cfg.stochSmooth);
  const k = last(sto.k);
  const dv = last(sto.d);
  ind.push({
    id: "stoch",
    name: `Stochastic (${cfg.stochPeriod},${cfg.stochSmooth})`,
    value: k != null && dv != null ? `${r2(k, 1)} / ${r2(dv, 1)}` : "—",
    vote: k == null || dv == null ? "HOLD" : k < 20 ? "BUY" : k > 80 ? "SELL" : k > dv ? "BUY" : "SELL",
    weight: 1,
    detail: k == null ? "—" : k < 20 ? "Oversold (<20)" : k > 80 ? "Overbought (>80)" : k > (dv ?? 0) ? "%K above %D — bullish" : "%K below %D — bearish",
  });

  // 8. VWAP (intraday only — daily candles span many sessions)
  const intraday = c.length > 1 && c[c.length - 1].t - c[c.length - 2].t < 86_400_000;
  const vw = intraday ? last(vwap(c)) : null;
  if (vw != null) {
    ind.push({
      id: "vwap",
      name: "VWAP (session)",
      value: r2(vw).toLocaleString("en-IN"),
      vote: voteOf(close > vw, close < vw),
      weight: 1,
      detail: close > vw ? "Price above VWAP — buyers in control" : "Price below VWAP — sellers in control",
    });
  }

  // 9. Volume vs period average
  const vols = c.map((x) => x.v);
  const vAvg = last(sma(vols, cfg.volumePeriod));
  const vNow = vols[vols.length - 1];
  const up = close >= prevClose;
  if (vAvg && vAvg > 0) {
    const ratio = vNow / vAvg;
    ind.push({
      id: "volume",
      name: `Volume vs ${cfg.volumePeriod}-avg`,
      value: `${r2(ratio, 2)}×`,
      vote: ratio < 1.2 ? "HOLD" : up ? "BUY" : "SELL",
      weight: 0.5,
      detail: ratio < 1.2 ? "Normal volume — no confirmation" : `${r2(ratio, 1)}× average volume on a ${up ? "up" : "down"} candle`,
    });
  }

  // 10. Price vs EMA (medium-term bias)
  const e50v = last(e50);
  if (e50v != null) {
    ind.push({
      id: "ema50",
      name: `Price vs EMA ${cfg.ema50Period}`,
      value: r2(e50v).toLocaleString("en-IN"),
      vote: voteOf(close > e50v, close < e50v),
      weight: 1,
      detail: close > e50v ? `Price ${r2(((close - e50v) / e50v) * 100, 1)}% above EMA ${cfg.ema50Period}` : `Price ${r2(((e50v - close) / e50v) * 100, 1)}% below EMA ${cfg.ema50Period}`,
    });
  }

  // 11. ORB (Opening Range Breakout) — First 15-min range of the current trading session
  const lastDayStr = new Date(c[c.length - 1].t).toDateString();
  const todayCandles = c.filter((bar) => new Date(bar.t).toDateString() === lastDayStr);
  const orbBars = todayCandles.length >= 3 ? todayCandles.slice(0, 3) : c.slice(-15, -12);
  const orbHigh = r2(Math.max(...orbBars.map((b) => b.h)));
  const orbLow = r2(Math.min(...orbBars.map((b) => b.l)));
  const orbMid = r2((orbHigh + orbLow) / 2);
  const orbSpan = Math.max(orbHigh - orbLow, close * 0.003);
  const isOrbBull = close > orbHigh;
  const isOrbBear = close < orbLow;
  const orbStatus: "BULLISH_BREAKOUT" | "BEARISH_BREAKDOWN" | "INSIDE_RANGE" = isOrbBull
    ? "BULLISH_BREAKOUT"
    : isOrbBear
    ? "BEARISH_BREAKDOWN"
    : "INSIDE_RANGE";
  const orbVote: Vote = isOrbBull ? "BUY" : isOrbBear ? "SELL" : "HOLD";
  const orbInfo = {
    status: orbStatus,
    signal: orbVote,
    orbHigh,
    orbLow,
    orbMid,
    target: isOrbBull ? r2(orbHigh + orbSpan * 1.5) : isOrbBear ? r2(orbLow - orbSpan * 1.5) : r2(orbHigh + orbSpan),
    stopLoss: isOrbBull ? orbMid : isOrbBear ? orbMid : orbLow,
    detail: isOrbBull
      ? `ORB Bullish Breakout ABOVE ${orbHigh} (Range: ${orbLow}–${orbHigh})`
      : isOrbBear
      ? `ORB Bearish Breakdown BELOW ${orbLow} (Range: ${orbLow}–${orbHigh})`
      : `Inside Opening Range (${orbLow} – ${orbHigh})`,
  };

  ind.push({
    id: "orb",
    name: "ORB Breakout (15m)",
    value: `${orbLow} – ${orbHigh}`,
    vote: orbVote,
    weight: 2,
    detail: orbInfo.detail,
  });

  // ---------- combine ----------
  const totalWeight = ind.reduce((a, x) => a + x.weight, 0) || 1;
  const raw = ind.reduce((a, x) => a + (x.vote === "BUY" ? x.weight : x.vote === "SELL" ? -x.weight : 0), 0);
  const score = r2((raw / totalWeight) * 100, 0);
  const signal: Vote = score >= 25 ? "BUY" : score <= -25 ? "SELL" : "HOLD";
  const abs = Math.abs(score);
  const strength = abs >= 60 ? "STRONG" : abs >= 25 ? "MODERATE" : "WEAK";

  const atrV = last(atr(c)) ?? close * 0.01;
  const lookback = c.slice(-20);
  const support = Math.min(...lookback.map((x) => x.l));
  const resistance = Math.max(...lookback.map((x) => x.h));
  const dir = signal === "SELL" ? -1 : 1;
  const stopLoss = r2(close - dir * 1.5 * atrV);
  const target = r2(close + dir * 3 * atrV);
  const risk = Math.abs(close - stopLoss);

  return {
    signal,
    strength,
    score,
    buy: ind.filter((x) => x.vote === "BUY").length,
    sell: ind.filter((x) => x.vote === "SELL").length,
    hold: ind.filter((x) => x.vote === "HOLD").length,
    indicators: ind,
    levels: {
      atr: r2(atrV),
      stopLoss,
      target,
      support: r2(support),
      resistance: r2(resistance),
      riskReward: risk ? r2(Math.abs(target - close) / risk) : 0,
    },
    trend: stDir === 1 && strongTrend ? "UP" : stDir === -1 && strongTrend ? "DOWN" : "SIDEWAYS",
    close: r2(close),
    changePct: prevClose ? r2(((close - prevClose) / prevClose) * 100) : 0,
    candles: c.length,
    rsiCrossover: {
      type: rsiCrossType,
      signal: rsiCrossVote,
      detail: rsiCrossDetail,
      prevRsi: rsPrev != null ? r2(rsPrev, 1) : 50,
      currRsi: rs != null ? r2(rs, 1) : 50,
    },
    emaCrossover: emaCrossInfo,
    orbBreakout: orbInfo,
  };
}
