import { db } from "@/db";
import { setups } from "@/db/schema";
import { executeEntry, executeExit } from "@/lib/engine";
import { pickSetup } from "@/lib/setup-fields";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function load(id: string) {
  const [row] = await db.select().from(setups).where(eq(setups.id, Number(id)));
  return row ?? null;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const row = await load(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(row);
}

/** PUT — edit setup (allowed in any state; SL/Target/qty editable even while ENTERED) */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json();
  const data = pickSetup(body);
  const [row] = await db
    .update(setups)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(setups.id, Number(id)))
    .returning();
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(row);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  await db.delete(setups).where(eq(setups.id, Number(id)));
  return Response.json({ ok: true });
}

/**
 * POST /api/setups/:id { action: "activate" | "enter" | "exit" | "cancel" | "reset" | "duplicate" }
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { action } = await req.json();
  const s = await load(id);
  if (!s) return Response.json({ error: "not found" }, { status: 404 });

  switch (action) {
    case "activate": {
      if (s.status === "ENTERED") return Response.json({ ok: false, message: "Already in position" }, { status: 400 });
      await db.update(setups).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(setups.id, s.id));
      return Response.json({ ok: true, message: s.entryTrigger === "MANUAL" ? "Setup armed. Click ENTER to take position." : `Watching for ${s.entryTrigger} ${s.entryPrice}` });
    }
    case "enter": {
      if (s.status === "ENTERED") return Response.json({ ok: false, message: "Already entered" }, { status: 400 });
      const r = await executeEntry(s, "MANUAL ENTRY");
      return Response.json(r, { status: r.ok ? 200 : 400 });
    }
    case "exit": {
      if (s.status !== "ENTERED") return Response.json({ ok: false, message: "No open position" }, { status: 400 });
      const r = await executeExit(s, "MANUAL EXIT");
      return Response.json(r, { status: r.ok ? 200 : 400 });
    }
    case "cancel": {
      if (s.status === "ENTERED") return Response.json({ ok: false, message: "Exit position first" }, { status: 400 });
      await db.update(setups).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(setups.id, s.id));
      return Response.json({ ok: true, message: "Cancelled" });
    }
    case "reset": {
      await db
        .update(setups)
        .set({ status: "DRAFT", entryFilledPrice: null, exitFilledPrice: null, entryAt: null, exitAt: null, exitReason: "", pnl: 0, meta: {}, updatedAt: new Date() })
        .where(eq(setups.id, s.id));
      return Response.json({ ok: true, message: "Reset to draft" });
    }
    case "duplicate": {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = s;
      void _id; void _c; void _u;
      const [row] = await db
        .insert(setups)
        .values({ ...rest, name: `${s.name} (copy)`, status: "DRAFT", entryFilledPrice: null, exitFilledPrice: null, entryAt: null, exitAt: null, exitReason: "", pnl: 0, meta: {} })
        .returning();
      return Response.json({ ok: true, message: "Duplicated", setup: row });
    }
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}
