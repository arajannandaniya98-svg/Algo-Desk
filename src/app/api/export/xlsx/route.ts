import { NextRequest } from "next/server";
import { buildWorkbook, REPORT_FILENAME, saveWorkbookToDisk } from "@/lib/excel";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/export/xlsx        → download the single-sheet report (always fresh)
 * GET /api/export/xlsx?stats  → JSON status for the auto-sync panel
 * POST { action: "save" }     → overwrite exports/AlgoDesk-Report.xlsx on the server
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.has("stats")) {
    const { snap, setupsCount, ordersCount, strategiesCount, signalsCount, rows } = await buildWorkbook();
    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      sheet: "AlgoDesk",
      sheets: 1,
      sections: ["Capital & P&L", "Indicator Signals", "Setups & Positions", "Strategies", "Order Book", "Margin Allocation"],
      rows: { setups: setupsCount, orders: ordersCount, strategies: strategiesCount, signals: signalsCount, total: rows },
      capital: { total: snap.capital, used: snap.usedMargin, free: snap.freeMargin, equity: snap.equity },
      autoExcelMinutes: snap.settings.autoExcelMinutes,
      filename: REPORT_FILENAME,
    });
  }

  const { wb } = await buildWorkbook();
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${REPORT_FILENAME}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "save") return Response.json({ ok: false, message: "Unknown action" }, { status: 400 });
  try {
    const r = await saveWorkbookToDisk();
    return Response.json({ ok: true, message: `Saved ${r.file} (${Math.round(r.bytes / 1024)} KB · ${r.signalsCount} signals)`, ...r });
  } catch (e) {
    return Response.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
