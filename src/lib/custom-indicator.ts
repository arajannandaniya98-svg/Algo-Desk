import type { Candle } from "./indicators";

export interface PineStyleIndicator {
  id: string;
  name: string;
  formula: string;
  color: string;
  lineWidth: number;
  enabled: boolean;
}

export interface EvaluatedIndicator {
  points: { t: number; value: number }[];
  lastValue: number | null;
  error?: string;
}

/**
 * Lightweight Pine-style formula engine (safe parser, no eval).
 * Supported tokens:
 *   close open high low volume
 *   sma(close,20) ema(close,9) rsi(close,14) highest(high,20) lowest(low,20)
 *   abs(x) min(a,b) max(a,b)
 * Operators: + - * / ( )
 *
 * Example formulas:
 *   ema(close, 9)
 *   (ema(close,9) + ema(close,21)) / 2
 *   highest(high, 20)
 *   lowest(low, 20)
 *   close - sma(close, 20)
 */

type Series = (number | null)[];

function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values: number[], period: number): Series {
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

function rsi(values: number[], period: number): Series {
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const avg = (arr: number[]) => {
    const out: Series = new Array(arr.length).fill(null);
    if (arr.length < period) return out;
    let acc = 0;
    for (let i = 0; i < period; i++) acc += arr[i];
    let v = acc / period;
    out[period - 1] = v;
    for (let i = period; i < arr.length; i++) {
      v = (v * (period - 1) + arr[i]) / period;
      out[i] = v;
    }
    return out;
  };
  const ag = avg(gains);
  const al = avg(losses);
  return values.map((_, i) => {
    if (ag[i] == null || al[i] == null) return null;
    if (al[i] === 0) return 100;
    return 100 - 100 / (1 + (ag[i] as number) / (al[i] as number));
  });
}

function highest(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    out[i] = Math.max(...values.slice(i - period + 1, i + 1));
  }
  return out;
}

function lowest(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    out[i] = Math.min(...values.slice(i - period + 1, i + 1));
  }
  return out;
}

function toSeries(v: number[] | Series, len: number): Series {
  if (Array.isArray(v) && v.length === len) return v as Series;
  return new Array(len).fill(null);
}

/** Tokenize formula */
function tokenize(expr: string): string[] {
  const clean = expr.replace(/\s+/g, "");
  const parts = clean.match(/[A-Za-z_]+|\d+\.\d+|\d+|[()+\-*/,]/g);
  return parts ?? [];
}

/** Recursive descent parser that returns a series */
export function evaluateFormula(candles: Candle[], formula: string): EvaluatedIndicator {
  const len = candles.length;
  const close = candles.map((c) => c.c);
  const open = candles.map((c) => c.o);
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const volume = candles.map((c) => c.v);

  const tokens = tokenize(formula);
  let pos = 0;

  const scalarToSeries = (x: number): Series => new Array(len).fill(x);
  const bin = (a: Series, b: Series, op: string): Series =>
    a.map((v, i) => {
      const x = v;
      const y = b[i];
      if (x == null || y == null) return null;
      if (op === "+") return x + y;
      if (op === "-") return x - y;
      if (op === "*") return x * y;
      if (op === "/") return y === 0 ? null : x / y;
      return null;
    });

  const parsePrimary = (): Series => {
    const tok = tokens[pos++];
    if (!tok) throw new Error("Unexpected end of formula");
    if (tok === "(") {
      const x = parseExpr();
      if (tokens[pos++] !== ")") throw new Error("Missing )");
      return x;
    }
    if (/^\d/.test(tok)) return scalarToSeries(Number(tok));
    if (["close", "open", "high", "low", "volume"].includes(tok)) {
      return tok === "close" ? close : tok === "open" ? open : tok === "high" ? high : tok === "low" ? low : volume;
    }
    // function call
    if (/[A-Za-z_]+/.test(tok) && tokens[pos] === "(") {
      pos++; // (
      const args: Series[] = [];
      while (tokens[pos] && tokens[pos] !== ")") {
        args.push(parseExpr());
        if (tokens[pos] === ",") pos++;
      }
      if (tokens[pos++] !== ")") throw new Error("Missing ) after function args");
      const arg0 = args[0] ?? scalarToSeries(0);
      const arg1Scalar = args[1]?.find((v) => v != null) ?? 0;
      if (tok === "sma") return sma(arg0.map((v) => v ?? 0), Math.max(1, Math.round(Number(arg1Scalar))));
      if (tok === "ema") return ema(arg0.map((v) => v ?? 0), Math.max(1, Math.round(Number(arg1Scalar))));
      if (tok === "rsi") return rsi(arg0.map((v) => v ?? 0), Math.max(1, Math.round(Number(arg1Scalar))));
      if (tok === "highest") return highest(arg0.map((v) => v ?? 0), Math.max(1, Math.round(Number(arg1Scalar))));
      if (tok === "lowest") return lowest(arg0.map((v) => v ?? 0), Math.max(1, Math.round(Number(arg1Scalar))));
      if (tok === "abs") return arg0.map((v) => (v == null ? null : Math.abs(v)));
      if (tok === "min") {
        const b = args[1] ?? scalarToSeries(0);
        return arg0.map((v, i) => (v == null || b[i] == null ? null : Math.min(v, b[i] as number)));
      }
      if (tok === "max") {
        const b = args[1] ?? scalarToSeries(0);
        return arg0.map((v, i) => (v == null || b[i] == null ? null : Math.max(v, b[i] as number)));
      }
      throw new Error(`Unsupported function: ${tok}`);
    }
    throw new Error(`Unexpected token: ${tok}`);
  };

  const parseFactor = (): Series => {
    if (tokens[pos] === "-") {
      pos++;
      return parseFactor().map((v) => (v == null ? null : -v));
    }
    return parsePrimary();
  };

  const parseTerm = (): Series => {
    let left = parseFactor();
    while (tokens[pos] === "*" || tokens[pos] === "/") {
      const op = tokens[pos++];
      const right = parseFactor();
      left = bin(left, right, op);
    }
    return left;
  };

  const parseExpr = (): Series => {
    let left = parseTerm();
    while (tokens[pos] === "+" || tokens[pos] === "-") {
      const op = tokens[pos++];
      const right = parseTerm();
      left = bin(left, right, op);
    }
    return left;
  };

  try {
    const vals = parseExpr();
    const points = vals
      .map((v, i) => (v == null || !Number.isFinite(v) ? null : { t: candles[i].t, value: +v.toFixed(4) }))
      .filter((x): x is { t: number; value: number } => !!x);
    return {
      points,
      lastValue: points.length ? points[points.length - 1].value : null,
    };
  } catch (e) {
    return { points: [], lastValue: null, error: (e as Error).message };
  }
}
