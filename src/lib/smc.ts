import type { Candle } from "./indicators";

/**
 * Smart Money Concepts (SMC) / price-action analysis:
 *  - swing structure (HH/HL/LH/LL) + BOS / CHoCH
 *  - Order Blocks (last opposite candle before an impulsive structure break)
 *  - Fair Value Gaps (3-candle imbalance)
 *  - Equilibrium (50% of the dealing range) + premium / discount zones
 *  - liquidity (equal highs/lows)
 *  - a rule-based ENTRY / SL / TARGET trade plan
 */
export interface Zone {
  type: "OB+" | "OB-" | "FVG+" | "FVG-";
  top: number;
  bottom: number;
  t: number; // start time (ms)
  mitigated: boolean;
  touched: boolean;
}
export interface StructureBreak {
  kind: "BOS" | "CHoCH";
  dir: "UP" | "DOWN";
  level: number;
  t: number; // break candle time
  swingT: number; // broken swing time
}
export interface SwingPt {
  t: number;
  price: number;
  kind: "HH" | "HL" | "LH" | "LL" | "H" | "L";
}
export interface SmcPlan {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  action: "BUY" | "SELL" | "WAIT";
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  zone: string;
  reason: string;
  inZone: boolean;
}
export interface SmcResult {
  swings: SwingPt[];
  breaks: StructureBreak[];
  zones: Zone[];
  equilibrium: { high: number; low: number; eq: number; pricePosition: "PREMIUM" | "DISCOUNT" | "EQ" };
  liquidity: { level: number; side: "high" | "low"; count: number }[];
  plan: SmcPlan;
  trend: "UP" | "DOWN" | "RANGE";
}

const K = 3; // fractal lookback

function findSwings(c: Candle[]): { idx: number; price: number; isHigh: boolean }[] {
  const out: { idx: number; price: number; isHigh: boolean }[] = [];
  for (let i = K; i < c.length - K; i++) {
    let isH = true;
    let isL = true;
    for (let j = 1; j <= K; j++) {
      if (c[i].h < c[i - j].h || c[i].h < c[i + j].h) isH = false;
      if (c[i].l > c[i - j].l || c[i].l > c[i + j].l) isL = false;
    }
    if (isH) out.push({ idx: i, price: c[i].h, isHigh: true });
    else if (isL) out.push({ idx: i, price: c[i].l, isHigh: false });
  }
  // de-duplicate consecutive same-side swings (keep extreme)
  const dedup: typeof out = [];
  for (const s of out) {
    const last = dedup[dedup.length - 1];
    if (last && last.isHigh === s.isHigh) {
      if ((s.isHigh && s.price >= last.price) || (!s.isHigh && s.price <= last.price)) dedup[dedup.length - 1] = s;
    } else dedup.push(s);
  }
  return dedup;
}

export function analyseSmc(candles: Candle[]): SmcResult | null {
  const c = candles.slice(-300);
  if (c.length < 40) return null;
  const close = c[c.length - 1].c;
  const swings = findSwings(c);
  if (swings.length < 4) return null;

  // ---------- structure walk: BOS / CHoCH ----------
  const breaks: StructureBreak[] = [];
  let trendDir: "UP" | "DOWN" | null = null;
  let lastHigh: { idx: number; price: number } | null = null;
  let lastLow: { idx: number; price: number } | null = null;
  let sPtr = 0;
  const brokenSwings = new Set<number>();
  for (let i = 0; i < c.length; i++) {
    while (sPtr < swings.length && swings[sPtr].idx <= i - 1) {
      const s = swings[sPtr];
      if (s.isHigh) lastHigh = { idx: s.idx, price: s.price };
      else lastLow = { idx: s.idx, price: s.price };
      sPtr++;
    }
    if (lastHigh && !brokenSwings.has(lastHigh.idx) && c[i].c > lastHigh.price) {
      breaks.push({ kind: trendDir === "DOWN" ? "CHoCH" : "BOS", dir: "UP", level: lastHigh.price, t: c[i].t, swingT: c[lastHigh.idx].t });
      brokenSwings.add(lastHigh.idx);
      trendDir = "UP";
    }
    if (lastLow && !brokenSwings.has(lastLow.idx) && c[i].c < lastLow.price) {
      breaks.push({ kind: trendDir === "UP" ? "CHoCH" : "BOS", dir: "DOWN", level: lastLow.price, t: c[i].t, swingT: c[lastLow.idx].t });
      brokenSwings.add(lastLow.idx);
      trendDir = "DOWN";
    }
  }
  const recentBreaks = breaks.slice(-8);

  // ---------- swing labels (HH/HL/LH/LL) ----------
  const labeled: SwingPt[] = [];
  let prevH: number | null = null;
  let prevL: number | null = null;
  for (const s of swings) {
    let kind: SwingPt["kind"];
    if (s.isHigh) {
      kind = prevH == null ? "H" : s.price > prevH ? "HH" : "LH";
      prevH = s.price;
    } else {
      kind = prevL == null ? "L" : s.price > prevL ? "HL" : "LL";
      prevL = s.price;
    }
    labeled.push({ t: c[s.idx].t, price: s.price, kind });
  }

  // ---------- order blocks: last opposite candle before each break's impulse ----------
  const zones: Zone[] = [];
  const idxByTime = new Map(c.map((k, i) => [k.t, i]));
  for (const b of breaks.slice(-12)) {
    const bi = idxByTime.get(b.t) ?? -1;
    if (bi < 2) continue;
    // walk back from break candle to find last candle against the break direction
    for (let j = bi - 1; j >= Math.max(0, bi - 12); j--) {
      const bar = c[j];
      const against = b.dir === "UP" ? bar.c < bar.o : bar.c > bar.o;
      if (against) {
        zones.push({ type: b.dir === "UP" ? "OB+" : "OB-", top: Math.max(bar.o, bar.c, bar.h), bottom: Math.min(bar.o, bar.c, bar.l), t: bar.t, mitigated: false, touched: false });
        break;
      }
    }
  }

  // ---------- FVG (3-candle imbalance) ----------
  for (let i = 2; i < c.length; i++) {
    const a = c[i - 2];
    const b3 = c[i];
    if (a.h < b3.l && b3.l - a.h > close * 0.0003) zones.push({ type: "FVG+", top: b3.l, bottom: a.h, t: c[i - 1].t, mitigated: false, touched: false });
    if (a.l > b3.h && a.l - b3.h > close * 0.0003) zones.push({ type: "FVG-", top: a.l, bottom: b3.h, t: c[i - 1].t, mitigated: false, touched: false });
  }

  // ---------- mitigation: did price come back through the zone later? ----------
  for (const z of zones) {
    const zi = idxByTime.get(z.t) ?? 0;
    for (let i = zi + 2; i < c.length; i++) {
      const bullish = z.type.endsWith("+");
      if (bullish && c[i].l <= z.top) {
        z.touched = true;
        if (c[i].c < z.bottom || c[i].l < z.bottom) z.mitigated = true;
      }
      if (!bullish && c[i].h >= z.bottom) {
        z.touched = true;
        if (c[i].c > z.top || c[i].h > z.top) z.mitigated = true;
      }
      if (z.mitigated) break;
    }
  }
  // keep recent & unmitigated first, cap count
  const active = zones
    .filter((z) => !z.mitigated)
    .sort((a, b) => b.t - a.t)
    .slice(0, 10);

  // ---------- equilibrium / premium-discount ----------
  const look = c.slice(-120);
  const rangeHigh = Math.max(...look.map((x) => x.h));
  const rangeLow = Math.min(...look.map((x) => x.l));
  const eq = +((rangeHigh + rangeLow) / 2).toFixed(2);
  const pos = close > eq * 1.001 ? "PREMIUM" : close < eq * 0.999 ? "DISCOUNT" : "EQ";

  // ---------- liquidity: equal highs / equal lows (within 0.05%) ----------
  const liquidity: SmcResult["liquidity"] = [];
  const tol = close * 0.0007;
  const highs = labeled.filter((s) => s.kind.includes("H"));
  const lows = labeled.filter((s) => s.kind.includes("L") && !s.kind.includes("H"));
  const cluster = (pts: SwingPt[], side: "high" | "low") => {
    const used = new Set<number>();
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const grp = [pts[i]];
      for (let j = i + 1; j < pts.length; j++) if (Math.abs(pts[j].price - pts[i].price) < tol) { grp.push(pts[j]); used.add(j); }
      if (grp.length >= 2) liquidity.push({ level: +(grp.reduce((a, g) => a + g.price, 0) / grp.length).toFixed(2), side, count: grp.length });
    }
  };
  cluster(highs.slice(-10), "high");
  cluster(lows.slice(-10), "low");

  // ---------- trade plan ----------
  const lastBreak = recentBreaks[recentBreaks.length - 1];
  const bias: SmcPlan["bias"] = lastBreak ? (lastBreak.dir === "UP" ? "BULLISH" : "BEARISH") : "NEUTRAL";
  const bullZones = active.filter((z) => z.type.endsWith("+") && z.top < close).sort((a, b) => b.top - a.top);
  const bearZones = active.filter((z) => z.type.endsWith("-") && z.bottom > close).sort((a, b) => a.bottom - b.bottom);
  const r2 = (n: number) => +n.toFixed(2);
  let plan: SmcPlan;
  const swingHighTgt = labeled.filter((s) => s.kind.includes("H")).slice(-1)[0]?.price ?? rangeHigh;
  const swingLowTgt = labeled.filter((s) => !s.kind.includes("H")).slice(-1)[0]?.price ?? rangeLow;

  if (bias === "BULLISH" && bullZones.length) {
    const z = bullZones[0];
    const entry = r2(z.top);
    const sl = r2(z.bottom - (z.top - z.bottom) * 0.25);
    const t1 = r2(Math.max(eq, close));
    const t2 = r2(Math.max(swingHighTgt, rangeHigh));
    const inZone = close <= z.top * 1.002 && close >= z.bottom * 0.998;
    plan = {
      bias,
      action: pos === "DISCOUNT" || inZone ? "BUY" : "WAIT",
      entry,
      stopLoss: sl,
      target1: t1,
      target2: t2,
      riskReward: entry - sl > 0 ? r2((t2 - entry) / (entry - sl)) : 0,
      zone: `${z.type} ${r2(z.bottom)}–${r2(z.top)}`,
      reason: `${lastBreak?.kind ?? "BOS"} UP pachhi ${z.type.startsWith("OB") ? "Order Block" : "FVG"} par pullback entry${pos === "PREMIUM" ? " (price PREMIUM ma chhe — discount sudhi rah juo)" : ""}`,
      inZone,
    };
  } else if (bias === "BEARISH" && bearZones.length) {
    const z = bearZones[0];
    const entry = r2(z.bottom);
    const sl = r2(z.top + (z.top - z.bottom) * 0.25);
    const t1 = r2(Math.min(eq, close));
    const t2 = r2(Math.min(swingLowTgt, rangeLow));
    const inZone = close >= z.bottom * 0.998 && close <= z.top * 1.002;
    plan = {
      bias,
      action: pos === "PREMIUM" || inZone ? "SELL" : "WAIT",
      entry,
      stopLoss: sl,
      target1: t1,
      target2: t2,
      riskReward: sl - entry > 0 ? r2((entry - t2) / (sl - entry)) : 0,
      zone: `${z.type} ${r2(z.bottom)}–${r2(z.top)}`,
      reason: `${lastBreak?.kind ?? "BOS"} DOWN pachhi ${z.type.startsWith("OB") ? "Order Block" : "FVG"} par pullback entry${pos === "DISCOUNT" ? " (price DISCOUNT ma chhe — premium sudhi rah juo)" : ""}`,
      inZone,
    };
  } else {
    plan = { bias, action: "WAIT", entry: close, stopLoss: r2(rangeLow), target1: eq, target2: r2(rangeHigh), riskReward: 0, zone: "—", reason: bias === "NEUTRAL" ? "Structure clear nathi — BOS ni rah juo" : "Active unmitigated zone nathi — fresh BOS/zone ni rah juo", inZone: false };
  }

  return {
    swings: labeled.slice(-14),
    breaks: recentBreaks,
    zones: active,
    equilibrium: { high: r2(rangeHigh), low: r2(rangeLow), eq, pricePosition: pos },
    liquidity: liquidity.slice(0, 6),
    plan,
    trend: bias === "BULLISH" ? "UP" : bias === "BEARISH" ? "DOWN" : "RANGE",
  };
}
