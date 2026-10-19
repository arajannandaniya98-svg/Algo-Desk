export interface LegSpec {
  instrumentType: "CE" | "PE" | "FUT";
  offset: number; // strike offset in steps from ATM (0 = ATM)
  side: "BUY" | "SELL";
  ratio: number; // lots multiplier
}

export interface IndicatorTriggerRule {
  indicator: "SUPERTREND" | "EMA_CROSS" | "ORB_BREAKOUT" | "RSI" | "MACD" | "ALL_COMBINED" | "RSI_CROSSOVER";
  condition: "BUY" | "SELL" | "RSI_OVERSOLD" | "RSI_OVERBOUGHT" | "RSI_50_CROSS_UP" | "RSI_50_CROSS_DOWN";
  minScore?: number; // e.g. 35 for combined
  confirmCandles?: 0 | 1 | 2; // 0 = Running Candle, 1 = -1 Candle, 2 = -2 Candle
  exitOnSignalFlip?: boolean; // auto square-off when opposite signal triggers (e.g. Call exit on Put cross, Put exit on Call cross)
}

export interface StrategyTemplate {
  id: string;
  name: string;
  desc: string;
  outlook: string;
  legs: LegSpec[];
  category?: "CLASSIC" | "INDICATOR_BASED" | "CUSTOM";
  indicatorTrigger?: IndicatorTriggerRule;
}

export const TEMPLATES: StrategyTemplate[] = [
  { id: "LONG_STRADDLE", name: "Long Straddle", desc: "Buy ATM CE + ATM PE", outlook: "Big move either way / IV rise", legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }] },
  { id: "SHORT_STRADDLE", name: "Short Straddle", desc: "Sell ATM CE + ATM PE", outlook: "Range bound, theta decay", legs: [{ instrumentType: "CE", offset: 0, side: "SELL", ratio: 1 }, { instrumentType: "PE", offset: 0, side: "SELL", ratio: 1 }] },
  { id: "LONG_STRANGLE", name: "Long Strangle", desc: "Buy OTM CE + OTM PE", outlook: "Big move, cheaper than straddle", legs: [{ instrumentType: "CE", offset: 2, side: "BUY", ratio: 1 }, { instrumentType: "PE", offset: -2, side: "BUY", ratio: 1 }] },
  { id: "SHORT_STRANGLE", name: "Short Strangle", desc: "Sell OTM CE + OTM PE", outlook: "Range bound, high margin", legs: [{ instrumentType: "CE", offset: 2, side: "SELL", ratio: 1 }, { instrumentType: "PE", offset: -2, side: "SELL", ratio: 1 }] },
  { id: "BULL_CALL_SPREAD", name: "Bull Call Spread", desc: "Buy ATM CE, Sell OTM CE", outlook: "Moderately bullish", legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "CE", offset: 2, side: "SELL", ratio: 1 }] },
  { id: "BEAR_PUT_SPREAD", name: "Bear Put Spread", desc: "Buy ATM PE, Sell OTM PE", outlook: "Moderately bearish", legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "PE", offset: -2, side: "SELL", ratio: 1 }] },
  { id: "BULL_PUT_SPREAD", name: "Bull Put Spread", desc: "Sell OTM PE, Buy far OTM PE", outlook: "Bullish / credit", legs: [{ instrumentType: "PE", offset: -2, side: "SELL", ratio: 1 }, { instrumentType: "PE", offset: -4, side: "BUY", ratio: 1 }] },
  { id: "BEAR_CALL_SPREAD", name: "Bear Call Spread", desc: "Sell OTM CE, Buy far OTM CE", outlook: "Bearish / credit", legs: [{ instrumentType: "CE", offset: 2, side: "SELL", ratio: 1 }, { instrumentType: "CE", offset: 4, side: "BUY", ratio: 1 }] },
  { id: "IRON_CONDOR", name: "Iron Condor", desc: "Sell ±1, Buy ±2 (4 legs)", outlook: "Range bound, defined risk", legs: [{ instrumentType: "PE", offset: -2, side: "BUY", ratio: 1 }, { instrumentType: "PE", offset: -1, side: "SELL", ratio: 1 }, { instrumentType: "CE", offset: 1, side: "SELL", ratio: 1 }, { instrumentType: "CE", offset: 2, side: "BUY", ratio: 1 }] },
  { id: "IRON_FLY", name: "Iron Butterfly", desc: "Sell ATM straddle, buy wings", outlook: "Pin at strike, high theta", legs: [{ instrumentType: "CE", offset: 0, side: "SELL", ratio: 1 }, { instrumentType: "PE", offset: 0, side: "SELL", ratio: 1 }, { instrumentType: "CE", offset: 2, side: "BUY", ratio: 1 }, { instrumentType: "PE", offset: -2, side: "BUY", ratio: 1 }] },
  { id: "BUTTERFLY", name: "Long Butterfly (CE)", desc: "Buy -1, Sell 2 ATM, Buy +1", outlook: "Expect pin near ATM", legs: [{ instrumentType: "CE", offset: -1, side: "BUY", ratio: 1 }, { instrumentType: "CE", offset: 0, side: "SELL", ratio: 2 }, { instrumentType: "CE", offset: 1, side: "BUY", ratio: 1 }] },
  { id: "RATIO_CALL_SPREAD", name: "Call Ratio Spread", desc: "Buy 1 ATM, Sell 2 OTM", outlook: "Mildly bullish / flat", legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "CE", offset: 2, side: "SELL", ratio: 2 }] },
  { id: "COVERED_CALL", name: "Covered Call (FUT)", desc: "Buy FUT, Sell OTM CE", outlook: "Mildly bullish + income", legs: [{ instrumentType: "FUT", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "CE", offset: 2, side: "SELL", ratio: 1 }] },
  { id: "PROTECTIVE_PUT", name: "Protective Put (FUT)", desc: "Buy FUT, Buy OTM PE", outlook: "Bullish with hedge", legs: [{ instrumentType: "FUT", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "PE", offset: -2, side: "BUY", ratio: 1 }], category: "CLASSIC" },
  // Indicator-based smart strategies:
  {
    id: "EMA9_21_CALL_RUNNING",
    name: "⚡ EMA 9×21 CALL Entry (Running Candle · 5m)",
    desc: "EMA 9 crosses above EMA 21 on running 5m candle -> Buy ATM CE · Auto Exit on Put Cross",
    outlook: "5m Running Candle Call Crossover",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "BUY", confirmCandles: 0, exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "EMA9_21_PUT_RUNNING",
    name: "⚡ EMA 9×21 PUT Entry (Running Candle · 5m)",
    desc: "EMA 9 crosses below EMA 21 on running 5m candle -> Buy ATM PE · Auto Exit on Call Cross",
    outlook: "5m Running Candle Put Crossover",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "SELL", confirmCandles: 0, exitOnSignalFlip: true },
    legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "EMA9_21_CALL_1C",
    name: "⚡ EMA 9×21 CALL Entry (-1 Candle · 5m)",
    desc: "EMA 9 crosses above EMA 21 (-1 candle confirm on 5m) -> Buy ATM CE · Auto Exit on Put Cross",
    outlook: "5m -1 Candle Confirmed Call Cross",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "BUY", confirmCandles: 1, exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "EMA9_21_PUT_1C",
    name: "⚡ EMA 9×21 PUT Entry (-1 Candle · 5m)",
    desc: "EMA 9 crosses below EMA 21 (-1 candle confirm on 5m) -> Buy ATM PE · Auto Exit on Call Cross",
    outlook: "5m -1 Candle Confirmed Put Cross",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "SELL", confirmCandles: 1, exitOnSignalFlip: true },
    legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "EMA9_21_CALL_2C",
    name: "⚡ EMA 9×21 CALL Entry (-2 Candle · 5m)",
    desc: "EMA 9 crosses above EMA 21 (-2 candle confirm on 5m) -> Buy ATM CE · Auto Exit on Put Cross",
    outlook: "5m -2 Candle Confirmed Call Cross",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "BUY", confirmCandles: 2, exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "EMA9_21_PUT_2C",
    name: "⚡ EMA 9×21 PUT Entry (-2 Candle · 5m)",
    desc: "EMA 9 crosses below EMA 21 (-2 candle confirm on 5m) -> Buy ATM PE · Auto Exit on Call Cross",
    outlook: "5m -2 Candle Confirmed Put Cross",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "SELL", confirmCandles: 2, exitOnSignalFlip: true },
    legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "ORB_BREAKOUT_CE",
    name: "🚀 ORB Bullish Breakout (Buy ATM CE)",
    desc: "Price breaks above 15m Opening Range High -> Buy ATM CE with ORB Mid Stop Loss",
    outlook: "Opening Range Bullish Breakout",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "ORB_BREAKOUT", condition: "BUY", exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "ORB_BREAKDOWN_PE",
    name: "📉 ORB Bearish Breakdown (Buy ATM PE)",
    desc: "Price breaks below 15m Opening Range Low -> Buy ATM PE with ORB Mid Stop Loss",
    outlook: "Opening Range Bearish Breakdown",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "ORB_BREAKOUT", condition: "SELL", exitOnSignalFlip: true },
    legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "SUPERTREND_MOMENTUM_CE",
    name: "⚡ Supertrend Bullish CE Momentum",
    desc: "Supertrend Buy Flip -> Buy ATM CE with dynamic stop",
    outlook: "Bullish Trend Trigger",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "SUPERTREND", condition: "BUY", exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "SUPERTREND_MOMENTUM_PE",
    name: "⚡ Supertrend Bearish PE Momentum",
    desc: "Supertrend Sell Flip -> Buy ATM PE with dynamic stop",
    outlook: "Bearish Trend Trigger",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "SUPERTREND", condition: "SELL", exitOnSignalFlip: true },
    legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "EMA_CROSS_BULL_SPREAD",
    name: "📈 EMA Golden Cross Bull Spread",
    desc: "EMA 9/21 Bullish Crossover -> Buy ATM CE + Sell OTM CE",
    outlook: "Bullish Crossover Confirmation",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "BUY", exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "CE", offset: 2, side: "SELL", ratio: 1 }],
  },
  {
    id: "EMA_CROSS_BEAR_SPREAD",
    name: "📉 EMA Death Cross Bear Spread",
    desc: "EMA 9/21 Bearish Crossover -> Buy ATM PE + Sell OTM PE",
    outlook: "Bearish Crossover Confirmation",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "EMA_CROSS", condition: "SELL", exitOnSignalFlip: true },
    legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }, { instrumentType: "PE", offset: -2, side: "SELL", ratio: 1 }],
  },
  {
    id: "RSI_REVERSAL_BUY",
    name: "🔄 RSI Oversold Reversal (Buy CE)",
    desc: "RSI crosses above 30 / 50 -> Buy ATM CE on bounce",
    outlook: "Oversold Reversal",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "RSI_CROSSOVER", condition: "BUY", exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "RSI_REVERSAL_SELL",
    name: "🔄 RSI Overbought Reversal (Buy PE)",
    desc: "RSI crosses below 70 / 50 -> Buy ATM PE on rejection",
    outlook: "Overbought Reversal",
    category: "INDICATOR_BASED",
    indicatorTrigger: { indicator: "RSI_CROSSOVER", condition: "SELL", exitOnSignalFlip: true },
    legs: [{ instrumentType: "PE", offset: 0, side: "BUY", ratio: 1 }],
  },
  {
    id: "CUSTOM_INDICATOR",
    name: "🎯 Custom Indicator-Triggered Strategy",
    desc: "Define custom legs triggered by selected indicator & score",
    outlook: "Configurable Indicator Entry",
    category: "CUSTOM",
    indicatorTrigger: { indicator: "ALL_COMBINED", condition: "BUY", minScore: 35, exitOnSignalFlip: true },
    legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }],
  },
  { id: "CUSTOM", name: "Custom Legs", desc: "Build your own combination", outlook: "Any", category: "CUSTOM", legs: [{ instrumentType: "CE", offset: 0, side: "BUY", ratio: 1 }] },
];

export function templateById(id: string): StrategyTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[TEMPLATES.length - 1];
}

export interface ResolvedLeg extends LegSpec {
  strike: number;
  premium: number;
  quantity: number; // units = lots × lotSize × ratio
  symbol: string;
  intrinsic: (price: number) => number;
}

export interface PayoffResult {
  legs: ResolvedLeg[];
  netPremium: number; // per-unit sum (credit + / debit -)
  netCashflow: number; // ₹ at entry (credit +, debit -)
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
  payoff: { price: number; pnl: number }[];
  marginRequired: number;
  spot: number;
  lotSize: number;
  step: number;
  atm: number;
}

/** Resolve legs against an option chain and compute expiry payoff */
export function computePayoff(opts: {
  spot: number;
  atm: number;
  step: number;
  lotSize: number;
  lots: number;
  chain: { strike: number; ce: { ltp: number }; pe: { ltp: number } }[];
  legs: LegSpec[];
}): PayoffResult {
  const { spot, atm, step, lotSize, lots, chain } = opts;
  const strikeOf = (offset: number) => {
    if (offset === 0) return atm;
    // for CE positive = OTM up, for PE negative = OTM down
    return +(atm + offset * step).toFixed(2);
  };

  const resolved: ResolvedLeg[] = opts.legs.map((l) => {
    const strike = l.instrumentType === "FUT" ? 0 : strikeOf(l.offset);
    let premium = 0;
    if (l.instrumentType === "FUT") premium = spot * 1.004;
    else {
      const row = chain.find((c) => Math.abs(c.strike - strike) < 0.001);
      premium = row ? (l.instrumentType === "CE" ? row.ce.ltp : row.pe.ltp) : 0.05;
    }
    const quantity = lots * lotSize * l.ratio;
    const symbol = l.instrumentType === "FUT" ? `${"FUT"}` : `${strike}${l.instrumentType}`;
    return {
      ...l,
      strike,
      premium,
      quantity,
      symbol,
      intrinsic: (price: number) => (l.instrumentType === "CE" ? Math.max(price - strike, 0) : l.instrumentType === "PE" ? Math.max(strike - price, 0) : price - spot * 1.004),
    };
  });

  const netPremium = resolved.reduce((a, l) => a + (l.side === "BUY" ? -l.premium : l.premium) * l.ratio, 0);
  const netCashflow = +resolved.reduce((a, l) => a + (l.side === "BUY" ? -l.premium : l.premium) * l.quantity, 0).toFixed(2);

  // price scan ±12%
  const lo = spot * 0.88;
  const hi = spot * 1.12;
  const points = 61;
  const payoff: { price: number; pnl: number }[] = [];
  for (let i = 0; i < points; i++) {
    const price = +(lo + ((hi - lo) * i) / (points - 1)).toFixed(2);
    let pnl = 0;
    for (const l of resolved) {
      const val = l.intrinsic(price) - l.premium;
      pnl += (l.side === "BUY" ? val : -val) * l.quantity;
    }
    payoff.push({ price, pnl: +pnl.toFixed(2) });
  }

  const pnls = payoff.map((p) => p.pnl);
  const maxProfit = +Math.max(...pnls).toFixed(2);
  const maxLoss = +Math.min(...pnls).toFixed(2);

  const breakevens: number[] = [];
  for (let i = 1; i < payoff.length; i++) {
    const a = payoff[i - 1];
    const b = payoff[i];
    if ((a.pnl <= 0 && b.pnl >= 0) || (a.pnl >= 0 && b.pnl <= 0)) {
      const t = Math.abs(a.pnl) / Math.max(Math.abs(a.pnl) + Math.abs(b.pnl), 0.0001);
      breakevens.push(+(a.price + (b.price - a.price) * t).toFixed(2));
    }
  }

  // approximate margin (index assumption) — short options/futures block funds
  let marginRequired = 0;
  for (const l of resolved) {
    if (l.side === "SELL") marginRequired += spot * l.quantity * 0.12 + l.premium * l.quantity * 0.5;
    else if (l.instrumentType === "FUT") marginRequired += spot * l.quantity * 0.15;
    else marginRequired += l.premium * l.quantity;
  }

  return {
    legs: resolved,
    netPremium: +netPremium.toFixed(2),
    netCashflow,
    maxProfit,
    maxLoss,
    breakevens: [...new Set(breakevens)].slice(0, 4),
    payoff,
    marginRequired: +marginRequired.toFixed(2),
    spot,
    lotSize,
    step,
    atm,
  };
}

/** Default protective SL/target for each leg based on its premium (used when creating setups) */
export function legProtective(leg: ResolvedLeg, spot: number) {
  if (leg.instrumentType === "FUT") {
    return { stopLoss: +(spot * (leg.side === "BUY" ? 0.995 : 1.005)).toFixed(2), target: +(spot * (leg.side === "BUY" ? 1.012 : 0.988)).toFixed(2) };
  }
  const slPct = leg.side === "BUY" ? 0.5 : 1.5; // buy: 50% premium loss, sell: 150% premium risk
  const tpPct = leg.side === "BUY" ? 1.0 : 1.0;
  return {
    stopLoss: +(leg.premium * (leg.side === "BUY" ? 1 - slPct : 1 + slPct)).toFixed(2),
    target: +(leg.premium * (leg.side === "BUY" ? 1 + tpPct : 1 - tpPct)).toFixed(2),
  };
}
