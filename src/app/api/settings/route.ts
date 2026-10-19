import { capitalSnapshot, getSettings, riskBasedQuantity, updateSettings } from "@/lib/capital";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const [settings, snap] = await Promise.all([getSettings(), capitalSnapshot()]);
  return Response.json({ settings, snapshot: snap });
}

export async function PUT(req: NextRequest) {
  const b = await req.json();
  const settings = await updateSettings(b);
  const snap = await capitalSnapshot();
  return Response.json({ settings, snapshot: snap });
}

/** POST — position size calculator */
export async function POST(req: NextRequest) {
  const b = await req.json();
  const s = await getSettings();
  const entry = Number(b.entry);
  const stopLoss = Number(b.stopLoss);
  if (!entry || !stopLoss) return Response.json({ error: "entry and stopLoss required" }, { status: 400 });
  const r = riskBasedQuantity({
    capital: Number(b.capital) || s.capital,
    riskPct: Number(b.riskPct) || s.riskPerTradePct,
    entry,
    stopLoss,
    lotSize: Number(b.lotSize) || 1,
    instrumentType: String(b.instrumentType || "EQ"),
  });
  return Response.json(r);
}
