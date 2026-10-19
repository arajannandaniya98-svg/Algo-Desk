import { db, pool } from "@/db";
import { brokers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { attachTickEngine } from "@/lib/engine";
import { getQuotes } from "@/lib/market";
import { openBroker } from "@/lib/security/secrets";
import { feedHub } from "./hub";
import { resolveFeedInstrument } from "./tokens";
import type { FeedInstrument } from "./types";

export const DEFAULT_FEED_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "INDIAVIX"];

async function leaseDefaults() {
  const hub = feedHub();
  const p = hub.provider;
  if (!p) return;
  const insts: FeedInstrument[] = [];
  for (const s of DEFAULT_FEED_SYMBOLS) {
    const i = await resolveFeedInstrument(p, { symbol: s, instrumentType: "INDEX" });
    if (i) insts.push(i);
  }
  hub.lease(insts, 0, true);
}

export async function startLiveFeed(brokerId: number): Promise<{ ok: boolean; message: string }> {
  const [row] = await db.select().from(brokers).where(eq(brokers.id, brokerId)).limit(1);
  if (!row) return { ok: false, message: "Broker account not found" };
  const b = openBroker(row);
  const hub = feedHub();
  if (b.provider === "dhan") {
    if (!b.clientId || !b.accessToken) return { ok: false, message: "Dhan: Client ID and Access Token are required (Brokers page)" };
    hub.start({ provider: "dhan", brokerId: b.id, label: b.label, clientId: b.clientId, accessToken: b.accessToken });
  } else if (b.provider === "angelone") {
    const feedToken = b.extra?.feedToken;
    if (!b.clientId || !b.apiKey || !b.accessToken || !feedToken) return { ok: false, message: "Angel One: click 🔐 Login on the Brokers page first (needs JWT + feed token)" };
    hub.start({ provider: "angelone", brokerId: b.id, label: b.label, clientId: b.clientId, accessToken: b.accessToken, apiKey: b.apiKey, feedToken });
  } else {
    return { ok: false, message: "Kotak Neo market feed is not supported yet — use a Dhan or Angel One account for live data (orders can still go to Kotak)" };
  }
  attachTickEngine(hub);
  await leaseDefaults();
  return { ok: true, message: `Connecting ${b.provider === "dhan" ? "Dhan" : "Angel One"} live feed (${b.label})…` };
}

export async function startDemoFeed(): Promise<{ ok: boolean; message: string }> {
  feedHub().startDemo(async (symbols) => {
    const q = await getQuotes(symbols);
    return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.ltp]));
  });
  await leaseDefaults();
  return { ok: true, message: "Demo feed started — SIMULATED ticks (never used for orders or P&L)" };
}

export function stopFeed() {
  feedHub().stop();
}

export async function feedSettings() {
  try {
    const r = await pool.query("select feed_broker_id, feed_auto_start, token_sync from app_settings where id = 1");
    const row = r.rows[0] ?? {};
    return { feedBrokerId: (row.feed_broker_id as number | null) ?? null, feedAutoStart: !!row.feed_auto_start, tokenSync: (row.token_sync ?? {}) as Record<string, { at: string; rows: number }> };
  } catch {
    return { feedBrokerId: null, feedAutoStart: false, tokenSync: {} };
  }
}

export async function saveFeedSettings(p: { feedBrokerId?: number | null; feedAutoStart?: boolean }) {
  await pool.query("insert into app_settings (id) values (1) on conflict (id) do nothing");
  if (p.feedBrokerId !== undefined) await pool.query("update app_settings set feed_broker_id = $1 where id = 1", [p.feedBrokerId]);
  if (p.feedAutoStart !== undefined) await pool.query("update app_settings set feed_auto_start = $1 where id = 1", [p.feedAutoStart]);
}

/** Called on server start (instrumentation) when auto-start is enabled. */
export async function autoStartFeed() {
  const s = await feedSettings();
  if (!s.feedAutoStart || !s.feedBrokerId) return;
  const r = await startLiveFeed(s.feedBrokerId);
  console.log(`[AlgoDesk] Live feed auto-start: ${r.message}`);
}
