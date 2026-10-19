import { db } from "@/db";
import { brokers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { pickBroker } from "@/lib/broker-fields";
import { testConnection, brokerLogin } from "@/lib/brokers";
import { maskBroker, openBroker, sealBrokerPatch } from "@/lib/security/secrets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const [row] = await db.select().from(brokers).where(eq(brokers.id, Number(id)));
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(maskBroker(row));
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json();
  const data = pickBroker(body);
  if (data.isDefault) await db.update(brokers).set({ isDefault: false }).where(eq(brokers.isDefault, true));
  const [row] = await db
    .update(brokers)
    .set({ ...sealBrokerPatch(data), updatedAt: new Date() })
    .where(eq(brokers.id, Number(id)))
    .returning();
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(maskBroker(row));
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  await db.delete(brokers).where(eq(brokers.id, Number(id)));
  return Response.json({ ok: true });
}

/** POST /api/brokers/:id  { action: "test" | "login" } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { action } = await req.json();
  const [row] = await db.select().from(brokers).where(eq(brokers.id, Number(id)));
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (action === "test") {
    const r = await testConnection(openBroker(row));
    return Response.json(r);
  }
  if (action === "login") {
    const r = await brokerLogin(openBroker(row));
    if (r.ok && r.update) {
      await db.update(brokers).set({ ...sealBrokerPatch(r.update as Record<string, unknown>), updatedAt: new Date() }).where(eq(brokers.id, row.id));
    }
    return Response.json({ ok: r.ok, message: r.message });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
}
