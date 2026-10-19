import { runEngineTick } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** POST /api/engine — one engine tick (evaluate triggers, SL, target) */
export async function POST() {
  try {
    const r = await runEngineTick();
    return Response.json({ ok: true, ...r, ts: Date.now() });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
