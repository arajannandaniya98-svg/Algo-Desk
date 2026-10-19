import { db } from "@/db";
import { orders } from "@/db/schema";
import { desc } from "drizzle-orm";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 200), 1000);
  const rows = await db.select().from(orders).orderBy(desc(orders.id)).limit(limit);
  return Response.json(rows);
}

export async function DELETE() {
  await db.delete(orders);
  return Response.json({ ok: true });
}
