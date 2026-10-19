import { NextRequest } from "next/server";
import { pool } from "@/db";
import { feedHub } from "@/lib/feed/hub";
import { resolveFeedInstrument } from "@/lib/feed/tokens";
import { deltaFeed, deltaInstrument } from "@/lib/feed/delta";
import type { FeedInstrument, FeedProvider, FeedStatus, LiveTick } from "@/lib/feed/types";

export const dynamic = "force-dynamic";

const SYMBOL_RE = /^[A-Z0-9&_.-]{1,32}$/;
const KEY_RE = /^(dhan|angelone|demo|delta):[A-Za-z0-9_]{1,16}:[A-Za-z0-9_.-]{1,40}$/;

/**
 * GET /api/stream?symbols=NIFTY,RELIANCE&keys=dhan:NSE_FNO:35008
 * Server-Sent Events: pushes broker ticks to the browser the moment they
 * arrive (coalesced per 50 ms) — no polling delay.
 */
export async function GET(req: NextRequest) {
  const hub = feedHub();
  const sp = req.nextUrl.searchParams;
  const symbols = [...new Set((sp.get("symbols") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s)))].slice(0, 300);
  const rawKeys = [...new Set((sp.get("keys") ?? "").split(",").map((s) => s.trim()).filter((k) => KEY_RE.test(k)))].slice(0, 600);
  const meta = new Map<string, { segment: string; exchange: string }>();
  if (symbols.length) {
    const r = await pool.query("select symbol, segment, exchange from instruments where symbol = any($1)", [symbols]);
    for (const row of r.rows) meta.set(row.symbol, { segment: row.segment, exchange: row.exchange });
  }

  let wanted = new Map<string, string>(); // feed key → app symbol label
  let insts: FeedInstrument[] = [];
  const dfeed = deltaFeed();
  let deltaInsts: FeedInstrument[] = [];
  const resolveAll = async () => {
    const p = hub.provider as FeedProvider | null;
    const next = new Map<string, string>();
    const list: FeedInstrument[] = [];
    const dList: FeedInstrument[] = [];
    for (const s of symbols) {
      const m = meta.get(s);
      if (m?.exchange === "DELTA") {
        const i = deltaInstrument(s);
        dList.push(i);
        next.set(i.key, s);
        continue;
      }
      if (!p) continue;
      const type = m?.segment === "INDEX" ? "INDEX" : !m || m.segment === "EQ" ? "EQ" : "FUT";
      const i = await resolveFeedInstrument(p, { symbol: s, underlying: s, instrumentType: type, exchange: m?.exchange });
      if (i) {
        list.push(i);
        next.set(i.key, s);
      }
    }
    for (const k of rawKeys) {
      const [prov, segment, token] = k.split(":");
      if (prov === "delta") {
        dList.push({ key: k, provider: "delta", segment, token, symbol: token });
        next.set(k, "");
        continue;
      }
      if (!p || prov !== p) continue;
      list.push({ key: k, provider: p, segment, token, symbol: token });
      next.set(k, "");
    }
    wanted = next;
    insts = list;
    deltaInsts = dList;
    hub.lease(list, 60_000);
    dfeed.lease(dList, 60_000);
  };
  await resolveAll();

  const enc = new TextEncoder();
  let closed = false;
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // ~2KB comment padding defeats proxy/CDN buffering so events flush immediately
      try {
        controller.enqueue(enc.encode(`: ${" ".repeat(2048)}\n\n`));
      } catch {
        /* ignore */
      }
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const label = (t: LiveTick) => ({ ...t, symbol: wanted.get(t.key) || t.symbol });
      send("status", hub.status());
      send("ticks", [...hub.snapshot(wanted.keys()), ...dfeed.snapshot(wanted.keys())].map(label));

      const pending = new Map<string, LiveTick>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        if (!pending.size) return;
        send("ticks", [...pending.values()].map(label));
        pending.clear();
      };
      const onTick = (t: LiveTick) => {
        if (!wanted.has(t.key)) return;
        pending.set(t.key, t);
        if (!timer) timer = setTimeout(flush, 25);
      };
      let lastProvider = hub.provider;
      let lastState = hub.status().state;
      const onStatus = (s: FeedStatus) => {
        send("status", s);
        if (s.provider !== lastProvider || (s.state === "connected" && lastState !== "connected")) {
          lastProvider = s.provider;
          resolveAll()
            .then(() => send("ticks", hub.snapshot(wanted.keys()).map(label)))
            .catch(() => {});
        }
        lastState = s.state;
      };
      hub.on("tick", onTick);
      hub.on("status", onStatus);
      const keepAlive = setInterval(() => {
        send("ping", { t: Date.now() });
        hub.lease(insts, 60_000);
        dfeed.lease(deltaInsts, 60_000);
      }, 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        if (timer) clearTimeout(timer);
        hub.off("tick", onTick);
        hub.off("status", onStatus);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
