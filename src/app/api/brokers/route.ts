import { db } from "@/db";
import { brokers } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { pickBroker } from "@/lib/broker-fields";
import { maskBroker, sealBrokerPatch } from "@/lib/security/secrets";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(brokers).orderBy(desc(brokers.isDefault), brokers.id);
  return Response.json(rows.map(maskBroker));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const data = pickBroker(body);
  if (!data.label || !data.provider) return Response.json({ error: "label and provider required" }, { status: 400 });
  if (data.isDefault) await db.update(brokers).set({ isDefault: false }).where(eq(brokers.isDefault, true));
  const [row] = await db
    .insert(brokers)
    .values(sealBrokerPatch(data) as typeof brokers.$inferInsert)
    .returning();
  return Response.json(maskBroker(row), { status: 201 });
}
