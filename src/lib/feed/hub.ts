import { EventEmitter } from "events";
import WebSocket from "ws";
import { angelRequest, DHAN_CODES, dhanModeFor, dhanRequests, parseAngel, parseDhan, type RawTick } from "./protocol";
import type { FeedCredentials, FeedInstrument, FeedProvider, FeedStatus, LiveTick } from "./types";

type Lease = { inst: FeedInstrument; until: number; sticky: boolean };
type DemoState = { price: number; prev: number; open: number; high: number; low: number; vol: number };
type Seeder = (symbols: string[]) => Promise<Record<string, number>>;

/**
 * Single shared broker WebSocket connection for the whole server process.
 * Instruments are "leased" (ref-counted by TTL) by SSE clients, the option
 * chain and the tick engine; expired leases are unsubscribed automatically.
 * Emits:  "tick" (LiveTick)  and  "status" (FeedStatus)
 */
export class FeedHub extends EventEmitter {
  private ws: WebSocket | null = null;
  private creds: FeedCredentials | null = null;
  private wantRunning = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private demoSeed: Seeder | null = null;
  private demoSeeding = false;
  private demo = new Map<string, DemoState>();
  private sent = new Map<string, number>();
  readonly leases = new Map<string, Lease>();
  readonly ticks = new Map<string, LiveTick>();
  private symbolKey = new Map<string, string>();
  private prevClose = new Map<string, number>();
  private prevOi = new Map<string, number>();
  private lastOi = new Map<string, number>();
  private recent: number[] = [];
  private latencyEma: number | null = null;
  private state: FeedStatus = {
    state: "stopped",
    provider: null,
    brokerId: null,
    brokerLabel: "",
    connectedAt: null,
    lastTickAt: null,
    ticksPerSec: 0,
    totalTicks: 0,
    subscriptions: 0,
    reconnects: 0,
    lastError: "",
    avgLatencyMs: null,
    simulated: false,
  };

  constructor() {
    super();
    this.setMaxListeners(1000);
    const t = setInterval(() => this.sweep(), 15_000);
    t.unref?.();
  }

  get provider(): FeedProvider | null {
    return this.state.provider;
  }
  isLive(): boolean {
    return this.state.state === "connected" && (this.state.provider === "dhan" || this.state.provider === "angelone");
  }

  status(): FeedStatus {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 5000);
    return { ...this.state, ticksPerSec: +(this.recent.length / 5).toFixed(1), subscriptions: this.leases.size, avgLatencyMs: this.latencyEma == null ? null : Math.round(this.latencyEma) };
  }

  private patch(p: Partial<FeedStatus>) {
    Object.assign(this.state, p);
    this.emit("status", this.status());
  }

  // ---------- lifecycle ----------
  start(creds: FeedCredentials) {
    this.stop(false);
    this.creds = creds;
    this.wantRunning = true;
    this.patch({ provider: creds.provider, brokerId: creds.brokerId, brokerLabel: creds.label, simulated: false, lastError: "", reconnects: 0, connectedAt: null, totalTicks: 0 });
    this.connect();
  }

  startDemo(seed: Seeder) {
    this.stop(false);
    this.wantRunning = true;
    this.demoSeed = seed;
    this.patch({ state: "connected", provider: "demo", brokerId: null, brokerLabel: "Demo simulator", simulated: true, connectedAt: Date.now(), lastError: "", reconnects: 0, totalTicks: 0 });
    this.demoTimer = setInterval(() => this.demoStep(), 250);
    this.demoTimer.unref?.();
  }

  stop(emit = true) {
    this.wantRunning = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.reconnectTimer = null;
    this.heartbeat = null;
    this.demoTimer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.on("error", () => {});
      try {
        if (this.creds?.provider === "dhan" && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ RequestCode: DHAN_CODES.disconnect }));
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.creds = null;
    this.sent.clear();
    this.leases.clear();
    this.ticks.clear();
    this.symbolKey.clear();
    this.prevClose.clear();
    this.prevOi.clear();
    this.lastOi.clear();
    this.demo.clear();
    this.latencyEma = null;
    if (emit) this.patch({ state: "stopped", provider: null, brokerId: null, brokerLabel: "", connectedAt: null, simulated: false });
  }

  private connect() {
    const c = this.creds;
    if (!c) return;
    this.patch({ state: this.state.reconnects > 0 ? "reconnecting" : "connecting" });
    let url: string;
    const headers: Record<string, string> = {};
    if (c.provider === "dhan") {
      url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(c.accessToken)}&clientId=${encodeURIComponent(c.clientId)}&authType=2`;
    } else {
      url = "wss://smartapisocket.angelone.in/smart-stream";
      headers.Authorization = `Bearer ${c.accessToken.replace(/^Bearer\s+/i, "")}`;
      headers["x-api-key"] = c.apiKey ?? "";
      headers["x-client-code"] = c.clientId;
      headers["x-feed-token"] = c.feedToken ?? "";
    }
    const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000, perMessageDeflate: false });
    this.ws = ws;
    ws.on("open", () => {
      this.patch({ state: "connected", connectedAt: Date.now(), lastError: "" });
      this.sent.clear();
      this.flush();
      if (c.provider === "angelone") {
        this.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 25_000);
        this.heartbeat.unref?.();
      }
    });
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      try {
        this.onMessage(data, isBinary);
      } catch (e) {
        this.patch({ lastError: `Packet parse error: ${(e as Error).message}` });
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      this.patch({ lastError: `Broker rejected the feed connection (HTTP ${res.statusCode}) — check access token / feed token / data subscription` });
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    });
    ws.on("error", (e: Error) => this.patch({ lastError: e.message }));
    ws.on("close", (code: number, reason: Buffer) => {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      if (this.ws !== ws) return;
      this.ws = null;
      this.sent.clear();
      if (!this.wantRunning) return;
      const n = this.state.reconnects + 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(n, 5));
      this.patch({ state: "reconnecting", reconnects: n, lastError: this.state.lastError || `Connection closed (${code}) ${reason.toString()}`.trim() });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    });
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean) {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (!isBinary) {
      const text = buf.toString("utf8");
      if (text === "pong") return;
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const msg = j.errorMessage ?? j.message ?? j.error;
        if (msg) this.patch({ lastError: String(msg) });
      } catch {
        /* ignore */
      }
      return;
    }
    const raws = this.creds?.provider === "dhan" ? parseDhan(buf) : [parseAngel(buf)].filter((x): x is RawTick => !!x);
    for (const r of raws) this.ingest(r);
  }

  private changeOf(ltp: number, prevClose: number) {
    const change = +(ltp - prevClose).toFixed(2);
    return { change, changePct: prevClose ? +((change / prevClose) * 100).toFixed(2) : 0 };
  }

  /** Dhan sends LTT in epoch seconds (IST-shifted on some accounts) — accept whichever is plausible. */
  private dhanTime(ltt: number | undefined, now: number): number | undefined {
    if (!ltt) return undefined;
    for (const ms of [ltt * 1000, (ltt - 19800) * 1000]) {
      const d = now - ms;
      if (d > -5000 && d < 300_000) return ms;
    }
    return undefined;
  }

  private emitTick(t: LiveTick) {
    this.ticks.set(t.key, t);
    this.emit("tick", t);
  }

  private ingest(r: RawTick) {
    const provider = this.state.provider;
    if (!provider) return;
    const key = `${provider}:${r.segment}:${r.token}`;
    const prev = this.ticks.get(key);
    if (r.kind === "disconnect") {
      this.patch({ lastError: `Feed disconnected by broker (code ${r.reason})` });
      return;
    }
    if (r.kind === "prevclose") {
      if (r.prevClose) this.prevClose.set(key, r.prevClose);
      if (r.prevOi != null) this.prevOi.set(key, r.prevOi);
      if (prev && r.prevClose) this.emitTick({ ...prev, prevClose: r.prevClose, prevOi: r.prevOi ?? prev.prevOi, ...this.changeOf(prev.ltp, r.prevClose) });
      return;
    }
    if (r.kind === "oi") {
      if (r.oi != null) {
        this.lastOi.set(key, r.oi);
        if (prev) this.emitTick({ ...prev, oi: r.oi });
      }
      return;
    }
    if (!(r.ltp && r.ltp > 0)) return;
    const now = Date.now();
    const exchTs = r.exchTs ?? this.dhanTime(r.ltt, now);
    if (r.prevClose) this.prevClose.set(key, r.prevClose);
    if (r.oi != null) this.lastOi.set(key, r.oi);
    const prevClose = this.prevClose.get(key) ?? prev?.prevClose;
    const tick: LiveTick = {
      key,
      symbol: this.leases.get(key)?.inst.symbol ?? prev?.symbol ?? r.token,
      provider,
      ltp: r.ltp,
      open: r.open || prev?.open,
      high: r.high || prev?.high,
      low: r.low || prev?.low,
      prevClose,
      ...(prevClose ? this.changeOf(r.ltp, prevClose) : {}),
      volume: r.volume ?? prev?.volume,
      oi: r.oi ?? this.lastOi.get(key) ?? prev?.oi,
      prevOi: this.prevOi.get(key) ?? prev?.prevOi,
      bid: r.bid || prev?.bid,
      ask: r.ask || prev?.ask,
      ltq: r.ltq ?? prev?.ltq,
      atp: r.atp || prev?.atp,
      exchTs: exchTs ?? now,
      recvTs: now,
      latencyMs: exchTs ? Math.max(0, now - exchTs) : null,
    };
    if (tick.latencyMs != null && tick.latencyMs < 60_000) this.latencyEma = this.latencyEma == null ? tick.latencyMs : this.latencyEma * 0.9 + tick.latencyMs * 0.1;
    this.state.totalTicks++;
    this.state.lastTickAt = now;
    this.recent.push(now);
    if (this.recent.length > 20_000) this.recent.splice(0, this.recent.length - 20_000);
    this.emitTick(tick);
  }

  // ---------- subscriptions ----------
  /** Subscribe (or extend) instruments. ttlMs ignored when sticky. */
  lease(insts: FeedInstrument[], ttlMs = 60_000, sticky = false) {
    const until = Date.now() + ttlMs;
    let added = false;
    for (const i of insts) {
      if (!i || i.provider !== this.state.provider) continue;
      const l = this.leases.get(i.key);
      if (l) {
        l.until = Math.max(l.until, until);
        l.sticky = l.sticky || sticky;
      } else {
        this.leases.set(i.key, { inst: i, until, sticky });
        added = true;
      }
      if (i.symbol) this.symbolKey.set(i.symbol, i.key);
    }
    if (added) this.flush();
  }

  private flush() {
    const ws = this.ws;
    const c = this.creds;
    if (!ws || ws.readyState !== WebSocket.OPEN || !c) return;
    const pending = [...this.leases.values()].map((l) => l.inst).filter((i) => !this.sent.has(i.key));
    if (!pending.length) return;
    if (c.provider === "dhan") {
      const quote = pending.filter((i) => dhanModeFor(i.segment) === "quote");
      const full = pending.filter((i) => dhanModeFor(i.segment) === "full");
      for (const m of dhanRequests(DHAN_CODES.quote, quote)) ws.send(m);
      for (const m of dhanRequests(DHAN_CODES.full, full)) ws.send(m);
      for (const i of quote) this.sent.set(i.key, DHAN_CODES.quote);
      for (const i of full) this.sent.set(i.key, DHAN_CODES.full);
    } else {
      for (let k = 0; k < pending.length; k += 100) ws.send(angelRequest(1, 3, pending.slice(k, k + 100)));
      for (const i of pending) this.sent.set(i.key, 3);
    }
  }

  private sweep() {
    const now = Date.now();
    const expired: FeedInstrument[] = [];
    for (const [k, l] of this.leases) {
      if (!l.sticky && l.until < now) {
        expired.push(l.inst);
        this.leases.delete(k);
      }
    }
    if (!expired.length) return;
    const ws = this.ws;
    const c = this.creds;
    if (ws && ws.readyState === WebSocket.OPEN && c) {
      const live = expired.filter((i) => this.sent.has(i.key));
      if (c.provider === "dhan") {
        for (const m of dhanRequests(DHAN_CODES.unquote, live.filter((i) => this.sent.get(i.key) === DHAN_CODES.quote))) ws.send(m);
        for (const m of dhanRequests(DHAN_CODES.unfull, live.filter((i) => this.sent.get(i.key) === DHAN_CODES.full))) ws.send(m);
      } else if (live.length) {
        ws.send(angelRequest(0, 3, live));
      }
    }
    for (const i of expired) {
      this.sent.delete(i.key);
      this.ticks.delete(i.key);
      this.demo.delete(i.key);
      if (this.symbolKey.get(i.symbol) === i.key) this.symbolKey.delete(i.symbol);
    }
  }

  tickByKey(key: string): LiveTick | undefined {
    return this.ticks.get(key);
  }
  tickBySymbol(symbol: string): LiveTick | undefined {
    const k = this.symbolKey.get(symbol);
    return k ? this.ticks.get(k) : undefined;
  }
  snapshot(keys: Iterable<string>): LiveTick[] {
    const out: LiveTick[] = [];
    for (const k of keys) {
      const t = this.ticks.get(k);
      if (t) out.push(t);
    }
    return out;
  }

  // ---------- demo (simulated ticks for testing the pipeline without a broker) ----------
  private demoStep() {
    const insts = [...this.leases.values()].map((l) => l.inst);
    const missing = insts.filter((i) => !this.demo.has(i.key));
    if (missing.length && this.demoSeed && !this.demoSeeding) {
      this.demoSeeding = true;
      this.demoSeed(missing.map((i) => i.symbol))
        .then((prices) => {
          for (const i of missing) {
            const p = prices[i.symbol];
            if (p && !this.demo.has(i.key)) this.demo.set(i.key, { price: p, prev: p, open: p, high: p, low: p, vol: 0 });
          }
        })
        .catch(() => {})
        .finally(() => {
          this.demoSeeding = false;
        });
    }
    const now = Date.now();
    for (const i of insts) {
      const d = this.demo.get(i.key);
      if (!d || Math.random() < 0.45) continue;
      d.price = Math.max(0.05, +(d.price + d.price * (Math.random() - 0.5) * 0.0006).toFixed(2));
      d.high = Math.max(d.high, d.price);
      d.low = Math.min(d.low, d.price);
      d.vol += Math.floor(Math.random() * 500);
      this.state.totalTicks++;
      this.state.lastTickAt = now;
      this.recent.push(now);
      this.emitTick({
        key: i.key,
        symbol: i.symbol,
        provider: "demo",
        ltp: d.price,
        open: d.open,
        high: d.high,
        low: d.low,
        prevClose: d.prev,
        ...this.changeOf(d.price, d.prev),
        volume: d.vol,
        bid: +(d.price - 0.05).toFixed(2),
        ask: +(d.price + 0.05).toFixed(2),
        exchTs: now,
        recvTs: now,
        latencyMs: 0,
        simulated: true,
      });
    }
  }
}

export function feedHub(): FeedHub {
  const g = globalThis as unknown as { __algodeskFeedHub?: FeedHub };
  return (g.__algodeskFeedHub ??= new FeedHub());
}
