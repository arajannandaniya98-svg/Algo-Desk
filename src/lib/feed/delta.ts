import WebSocket from "ws";
import { DELTA_WS } from "@/lib/data/delta";
import { feedHub } from "./hub";
import type { FeedInstrument, LiveTick } from "./types";

/**
 * Delta Exchange crypto live feed — public WebSocket, no API key needed, 24×7.
 * Runs independently of the NSE broker feed and emits ticks through the shared
 * hub emitter, so SSE streaming and the tick engine work for crypto too.
 * Connects on first lease, disconnects automatically when nothing is watched.
 */
type Lease = { inst: FeedInstrument; until: number; sticky: boolean };

class DeltaFeed {
  private ws: WebSocket | null = null;
  private wsState: "closed" | "connecting" | "open" = "closed";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnects = 0;
  readonly leases = new Map<string, Lease>();
  readonly ticks = new Map<string, LiveTick>();
  private subscribed = new Set<string>();
  private recent: number[] = [];
  private totalTicks = 0;
  private lastTickAt: number | null = null;
  private lastError = "";
  private connectedAt: number | null = null;

  constructor() {
    const t = setInterval(() => this.sweep(), 15_000);
    t.unref?.();
  }

  status() {
    const now = Date.now();
    this.recent = this.recent.filter((x) => now - x < 5000);
    return {
      state: this.wsState === "open" ? "connected" : this.wsState === "connecting" ? "connecting" : "stopped",
      provider: "delta" as const,
      subscriptions: this.leases.size,
      ticksPerSec: +(this.recent.length / 5).toFixed(1),
      totalTicks: this.totalTicks,
      lastTickAt: this.lastTickAt,
      connectedAt: this.connectedAt,
      reconnects: this.reconnects,
      lastError: this.lastError,
    };
  }

  lease(insts: FeedInstrument[], ttlMs = 60_000, sticky = false) {
    const until = Date.now() + ttlMs;
    let added = false;
    for (const i of insts) {
      if (!i || i.provider !== "delta") continue;
      const l = this.leases.get(i.key);
      if (l) {
        l.until = Math.max(l.until, until);
        l.sticky = l.sticky || sticky;
      } else {
        this.leases.set(i.key, { inst: i, until, sticky });
        added = true;
      }
    }
    if (this.leases.size && this.wsState === "closed") this.connect();
    else if (added) this.flush();
  }

  tickByKey(key: string): LiveTick | undefined {
    return this.ticks.get(key);
  }
  snapshot(keys: Iterable<string>): LiveTick[] {
    const out: LiveTick[] = [];
    for (const k of keys) {
      const t = this.ticks.get(k);
      if (t) out.push(t);
    }
    return out;
  }

  private connect() {
    if (this.wsState !== "closed") return;
    this.wsState = "connecting";
    const ws = new WebSocket(DELTA_WS, { handshakeTimeout: 10_000, perMessageDeflate: false });
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.wsState = "open";
      this.connectedAt = Date.now();
      this.lastError = "";
      this.subscribed.clear();
      this.flush();
    });
    ws.on("message", (d: WebSocket.RawData) => {
      try {
        this.onMessage(JSON.parse(d.toString()) as Record<string, unknown>);
      } catch {
        /* non-JSON frame */
      }
    });
    ws.on("error", (e: Error) => {
      this.lastError = e.message;
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsState = "closed";
      this.subscribed.clear();
      if (!this.leases.size) return;
      this.reconnects++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnects, 5));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    });
  }

  private disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.wsState = "closed";
    this.subscribed.clear();
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => {});
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private send(type: "subscribe" | "unsubscribe", symbols: string[]) {
    if (!symbols.length || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < symbols.length; i += 50) {
      this.ws.send(JSON.stringify({ type, payload: { channels: [{ name: "v2/ticker", symbols: symbols.slice(i, i + 50) }] } }));
    }
  }

  private flush() {
    const want = [...this.leases.values()].map((l) => l.inst.token);
    this.send("subscribe", want.filter((s) => !this.subscribed.has(s)));
    for (const s of want) this.subscribed.add(s);
  }

  private sweep() {
    const now = Date.now();
    const gone: string[] = [];
    for (const [k, l] of this.leases) {
      if (!l.sticky && l.until < now) {
        gone.push(l.inst.token);
        this.leases.delete(k);
        this.ticks.delete(k);
      }
    }
    if (gone.length) {
      this.send("unsubscribe", gone);
      for (const s of gone) this.subscribed.delete(s);
    }
    if (!this.leases.size && this.wsState !== "closed") this.disconnect();
  }

  private onMessage(m: Record<string, unknown>) {
    if (m.type !== "v2/ticker" || typeof m.symbol !== "string") return;
    const key = `delta:DELTA:${m.symbol}`;
    if (!this.leases.has(key)) return;
    const n = (v: unknown): number | undefined => {
      const x = Number(v);
      return Number.isFinite(x) ? x : undefined;
    };
    const ltp = n(m.close) ?? n(m.mark_price);
    if (!ltp || ltp <= 0) return;
    const now = Date.now();
    const exchTs = typeof m.timestamp === "number" && m.timestamp > 1e15 ? Math.round(m.timestamp / 1000) : now;
    const prev = this.ticks.get(key);
    const open24 = n(m.open) ?? prev?.prevClose;
    const quotes = (m.quotes ?? null) as { best_bid?: unknown; best_ask?: unknown } | null;
    const tick: LiveTick = {
      key,
      symbol: this.leases.get(key)?.inst.symbol ?? m.symbol,
      provider: "delta",
      ltp,
      open: open24,
      high: n(m.high) ?? prev?.high,
      low: n(m.low) ?? prev?.low,
      prevClose: open24,
      change: open24 ? +(ltp - open24).toFixed(4) : undefined,
      changePct: open24 ? +(((ltp - open24) / open24) * 100).toFixed(2) : undefined,
      volume: n(m.volume) ?? prev?.volume,
      oi: n(m.oi_contracts) ?? n(m.oi) ?? prev?.oi,
      bid: n(quotes?.best_bid) ?? prev?.bid,
      ask: n(quotes?.best_ask) ?? prev?.ask,
      exchTs,
      recvTs: now,
      latencyMs: exchTs ? Math.max(0, now - exchTs) : null,
    };
    this.totalTicks++;
    this.lastTickAt = now;
    this.recent.push(now);
    if (this.recent.length > 20_000) this.recent.splice(0, this.recent.length - 20_000);
    this.ticks.set(key, tick);
    feedHub().emit("tick", tick); // shared emitter → SSE stream + tick engine
  }
}

export function deltaFeed(): DeltaFeed {
  const gl = globalThis as unknown as { __algodeskDeltaFeed?: DeltaFeed };
  return (gl.__algodeskDeltaFeed ??= new DeltaFeed());
}

export const deltaKey = (symbol: string) => `delta:DELTA:${symbol}`;
export const deltaInstrument = (symbol: string, appSymbol = symbol): FeedInstrument => ({ key: deltaKey(symbol), provider: "delta", segment: "DELTA", token: symbol, symbol: appSymbol, exchange: "DELTA" });
