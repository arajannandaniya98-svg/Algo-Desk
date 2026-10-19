import { db } from "@/db";
import { setups, strategies } from "@/db/schema";
import { executeEntry, executeExit } from "@/lib/engine";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/strategies/:id { action: "arm" | "enter" | "exit" | "reset" } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { action } = await req.json();
  const sid = Number(id);
  const [st] = await db.select().from(strategies).where(eq(strategies.id, sid));
  if (!st) return Response.json({ error: "not found" }, { status: 404 });
  const legs = await db.select().from(setups).where(eq(setups.strategyId, sid));

  const results: { leg: string; ok: boolean; message: string }[] = [];

  if (action === "arm") {
    for (const l of legs.filter((x) => x.status !== "ENTERED")) {
      await db.update(setups).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(setups.id, l.id));
    }
    await db.update(strategies).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(strategies.id, sid));
    return Response.json({ ok: true, message: `${legs.length} leg(s) armed` });
  }

  if (action === "enter" || action === "exit") {
    const targets = action === "enter" ? legs.filter((l) => l.status !== "ENTERED" && l.status !== "EXITED") : legs.filter((l) => l.status === "ENTERED");
    for (const l of targets) {
      const r = action === "enter" ? await executeEntry(l, "STRATEGY ENTRY") : await executeExit(l, "STRATEGY EXIT");
      results.push({ leg: l.name.split("·").pop()?.trim() || l.symbol, ok: r.ok, message: r.message });
    }
    const after = await db.select().from(setups).where(eq(setups.strategyId, sid));
    const status = after.every((l) => l.status === "EXITED") ? "EXITED" : after.some((l) => l.status === "ENTERED") ? "ENTERED" : "ACTIVE";
    await db.update(strategies).set({ status, updatedAt: new Date() }).where(eq(strategies.id, sid));
    const ok = results.length > 0 && results.every((r) => r.ok);
    return Response.json({
      ok,
      message: results.length === 0 ? "Nothing to do" : `${results.filter((r) => r.ok).length}/${results.length} legs ${action === "enter" ? "entered" : "exited"}`,
      results,
    });
  }

  if (action === "reset") {
    for (const l of legs) {
      await db
        .update(setups)
        .set({ status: "DRAFT", entryFilledPrice: null, exitFilledPrice: null, entryAt: null, exitAt: null, exitReason: "", pnl: 0, meta: {}, updatedAt: new Date() })
        .where(eq(setups.id, l.id));
    }
    await db.update(strategies).set({ status: "DRAFT", updatedAt: new Date() }).where(eq(strategies.id, sid));
    return Response.json({ ok: true, message: "Strategy reset to draft" });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
