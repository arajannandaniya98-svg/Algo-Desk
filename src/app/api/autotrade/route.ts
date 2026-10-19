import { NextRequest } from "next/server";
import { getSettings, updateSettings } from "@/lib/capital";
import { runAutoTradePass } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** GET /api/autotrade — fetch auto-trade status and settings */
export async function GET() {
  const settings = await getSettings();
  return Response.json({
    autoTrade: settings.autoTrade,
    indicatorConfig: settings.indicatorConfig,
  });
}

/** PUT /api/autotrade — update auto-trade configuration */
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const settings = await getSettings();

  const autoTradePatch = body.autoTrade
    ? {
        ...settings.autoTrade,
        ...body.autoTrade,
      }
    : settings.autoTrade;

  const indicatorConfigPatch = body.indicatorConfig
    ? {
        ...settings.indicatorConfig,
        ...body.indicatorConfig,
      }
    : settings.indicatorConfig;

  const updated = await updateSettings({
    autoTrade: autoTradePatch,
    indicatorConfig: indicatorConfigPatch,
  });

  // If enabled, run a pass immediately
  if (updated.autoTrade.enabled) {
    runAutoTradePass().catch(() => {});
  }

  return Response.json({
    ok: true,
    autoTrade: updated.autoTrade,
    indicatorConfig: updated.indicatorConfig,
  });
}
