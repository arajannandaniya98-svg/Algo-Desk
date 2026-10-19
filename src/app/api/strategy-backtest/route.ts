import { NextRequest } from "next/server";
import { generateBacktestExcel, runStrategyBacktest, type BacktestOptions } from "@/lib/backtest";
import { templateById } from "@/lib/strategies";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/strategy-backtest
 * Body: { underlying, template, interval, lots, legs, targetPct, stopLossPct, holdingBars, exportExcel?: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const underlying = String(body.underlying || "NIFTY").toUpperCase();
    const templateId = String(body.template || "CUSTOM");
    const interval = body.interval || "15m";
    const lots = Math.max(1, Number(body.lots) || 1);
    const legs = Array.isArray(body.legs) && body.legs.length ? body.legs : templateById(templateId).legs;

    const strategyName = String(body.strategyName || `${templateById(templateId).name} (${underlying})`);

    // Inherit indicator trigger from template or custom body configuration
    const tpl = templateById(templateId);
    const indicatorTrigger = body.indicatorTrigger || tpl.indicatorTrigger;
    const indicatorConfig = body.indicatorConfig;

    const opts: BacktestOptions = {
      underlying,
      strategyName,
      interval,
      lots,
      legs,
      targetPct: Number(body.targetPct) || 40,
      stopLossPct: Number(body.stopLossPct) || 30,
      holdingBars: Number(body.holdingBars) || 16,
      indicatorTrigger,
      indicatorConfig,
    };

    const summary = await runStrategyBacktest(opts);

    // If Excel export requested
    if (body.exportExcel) {
      const buffer = await generateBacktestExcel(summary);
      const filename = `Backtest-${underlying}-${templateId}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      return new Response(buffer, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return Response.json({
      ok: true,
      summary,
    });
  } catch (e) {
    return Response.json(
      {
        ok: false,
        error: (e as Error).message || "Backtest execution failed",
      },
      { status: 400 }
    );
  }
}
