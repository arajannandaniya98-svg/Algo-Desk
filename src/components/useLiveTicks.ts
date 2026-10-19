"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedStatus, LiveTick } from "@/lib/feed/types";

export type ClientTick = LiveTick & { dir?: "up" | "down"; flashAt?: number };

type QuoteRow = {
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  oi?: number;
  ts: number;
  source?: string;
  provider?: string;
  latencyMs?: number | null;
};

/**
 * Real-time ticks for the UI. Primary source: Server-Sent Events (broker/Delta
 * websocket pushed within 50 ms). Fallback: if the SSE stream is silent for a
 * few seconds (proxy buffering, feed off, market via Yahoo), it automatically
 * polls /api/quotes every 3 s so prices always keep updating.
 * Returns a map keyed by BOTH the app symbol ("NIFTY") and the feed key.
 */
export function useLiveTicks(symbols: string[], keys: string[] = []) {
  const [ticks, setTicks] = useState<Record<string, ClientTick>>({});
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const lastSseAt = useRef(0);
  const ticksRef = useRef<Record<string, ClientTick>>({});
  const sKey = [...new Set(symbols.filter(Boolean))].sort().join(",");
  const kKey = [...new Set(keys.filter(Boolean))].sort().join(",");

  // merge helper keeps flash/direction animation state
  const merge = (arr: ClientTick[]) => {
    if (!arr.length) return;
    const now = Date.now();
    setTicks((prev) => {
      const next = { ...prev };
      for (const t of arr) {
        const old = next[t.key] ?? (t.symbol ? next[t.symbol] : undefined);
        const moved = !!old && t.ltp !== old.ltp;
        const ct: ClientTick = { ...t, dir: moved ? (t.ltp > old.ltp ? "up" : "down") : old?.dir, flashAt: moved ? now : old?.flashAt };
        next[t.key] = ct;
        if (t.symbol) next[t.symbol] = ct;
      }
      ticksRef.current = next;
      return next;
    });
  };

  // ---------- SSE (0-delay pushes) ----------
  useEffect(() => {
    if (!sKey && !kKey) return;
    const qs = new URLSearchParams();
    if (sKey) qs.set("symbols", sKey);
    if (kKey) qs.set("keys", kKey);
    const es = new EventSource(`/api/stream?${qs.toString()}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("status", (e) => {
      try {
        setStatus(JSON.parse((e as MessageEvent).data) as FeedStatus);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("ticks", (e) => {
      let arr: LiveTick[] = [];
      try {
        arr = JSON.parse((e as MessageEvent).data) as LiveTick[];
      } catch {
        return;
      }
      if (!arr.length) return;
      lastSseAt.current = Date.now();
      merge(arr as ClientTick[]);
    });
    return () => {
      es.close();
      setConnected(false);
    };
  }, [sKey, kKey]);

  // ---------- polling fallback (always keeps prices fresh) ----------
  useEffect(() => {
    if (!sKey) return;
    let stop = false;
    const poll = async () => {
      // Per-symbol staleness: SSE may stream only SOME symbols (e.g. crypto),
      // so poll every symbol whose last update is older than 4 s.
      const now = Date.now();
      const stale = sKey.split(",").filter((sym) => {
        const t = ticksRef.current[sym];
        return !t || now - t.recvTs > 4000;
      });
      if (!stale.length) return;
      try {
        const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(stale.join(","))}`, { cache: "no-store" });
        if (!r.ok || stop) return;
        const j = (await r.json()) as Record<string, QuoteRow>;
        const now = Date.now();
        const arr: ClientTick[] = Object.values(j)
          .filter((q) => q && Number.isFinite(q.ltp) && q.ltp > 0)
          .map((q) => ({
            key: q.symbol,
            symbol: q.symbol,
            provider: (q.provider ?? q.source ?? "demo") as LiveTick["provider"],
            ltp: q.ltp,
            open: q.open,
            high: q.high,
            low: q.low,
            prevClose: q.prevClose,
            change: q.change,
            changePct: q.changePct,
            volume: q.volume,
            oi: q.oi,
            exchTs: q.ts || now,
            recvTs: now,
            latencyMs: q.latencyMs ?? null,
            simulated: q.source === "simulated",
          }));
        if (!stop) merge(arr);
      } catch {
        /* server unreachable — try again next cycle */
      }
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sKey]);

  return { ticks, status, connected };
}
