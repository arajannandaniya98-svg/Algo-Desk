import { NextRequest } from "next/server";
import { pool } from "@/db";
import { feedHub } from "@/lib/feed/hub";
import { deltaFeed } from "@/lib/feed/delta";
import { feedSettings, saveFeedSettings, startDemoFeed, startLiveFeed, stopFeed } from "@/lib/feed/control";
import { syncScripMaster, tokenStats } from "@/lib/feed/tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET — feed status, token master counts, settings, eligible broker accounts */
export async function GET() {
  const [tokens, settings, b] = await Promise.all([
    tokenStats(),
    feedSettings(),
    pool.query("select id, label, provider, mode, (access_token <> '') as has_token from brokers where provider in ('dhan','angelone') order by is_default desc, id"),
  ]);
  return Response.json({
    status: feedHub().status(),
    crypto: deltaFeed().status(),
    tokens,
    settings,
    brokers: b.rows.map((r) => ({ id: r.id, label: r.label, provider: r.provider, mode: r.mode, hasToken: !!r.has_token })),
  });
}

/** POST — { action: "start" | "demo" | "stop" | "autostart" | "sync" } (admin only, enforced in proxy) */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    switch (body.action) {
      case "start": {
        const brokerId = Number(body.brokerId);
        const r = await startLiveFeed(brokerId);
        if (r.ok) await saveFeedSettings({ feedBrokerId: brokerId, feedAutoStart: body.autoStart !== false });
        return Response.json({ ...r, status: feedHub().status() }, { status: r.ok ? 200 : 400 });
      }
      case "demo": {
        const r = await startDemoFeed();
        await saveFeedSettings({ feedAutoStart: false });
        return Response.json({ ...r, status: feedHub().status() });
      }
      case "stop": {
        stopFeed();
        await saveFeedSettings({ feedAutoStart: false });
        return Response.json({ ok: true, message: "Live feed stopped — prices fall back to Yahoo (~15 min delay)", status: feedHub().status() });
      }
      case "autostart": {
        await saveFeedSettings({ feedAutoStart: !!body.feedAutoStart });
        return Response.json({ ok: true, message: `Auto-start ${body.feedAutoStart ? "enabled" : "disabled"}` });
      }
      case "sync": {
        const provider = body.provider === "dhan" ? "dhan" : body.provider === "angelone" ? "angelone" : null;
        if (!provider) return Response.json({ ok: false, message: "provider must be dhan or angelone" }, { status: 400 });
        const r = await syncScripMaster(provider);
        return Response.json({ ok: true, message: `${provider === "dhan" ? "Dhan" : "Angel One"}: ${r.rows.toLocaleString("en-IN")} instruments synced in ${(r.ms / 1000).toFixed(1)}s`, ...r });
      }
      default:
        return Response.json({ ok: false, message: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
