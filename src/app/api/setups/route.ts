import { db } from "@/db";
import { setups } from "@/db/schema";
import { currentPrice, computePnl } from "@/lib/engine";
import { pickSetup } from "@/lib/setup-fields";
import { desc } from "drizzle-orm";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(setups).orderBy(desc(setups.updatedAt));
  const withLtp = await Promise.all(
    rows.map(async (s) => {
      const ltp = await currentPrice(s);
      const unrealized = s.status === "ENTERED" && ltp != null ? computePnl(s, ltp) : 0;
      return { ...s, ltp, unrealized };
    }),
  );
  return Response.json(withLtp);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const data = pickSetup(body);
  if (!data.symbol || !data.name) return Response.json({ error: "name and symbol required" }, { status: 400 });
  if (!data.status) data.status = "DRAFT";

  // Auto-resolve broker based on market if not specified
  if (!data.brokerId) {
    const { resolveAutoBroker } = await import("@/lib/brokers");
    const autoB = await resolveAutoBroker({
      exchange: (data.exchange as string) || "NSE",
      symbol: data.symbol as string,
      segment: (data.segment as string) || "EQ",
    });
    if (autoB) data.brokerId = autoB.id;
  }

  const [row] = await db
    .insert(setups)
    .values(data as typeof setups.$inferInsert)
    .returning();
  return Response.json(row, { status: 201 });
}
