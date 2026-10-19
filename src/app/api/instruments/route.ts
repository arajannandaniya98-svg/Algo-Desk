import { db } from "@/db";
import { instruments } from "@/db/schema";
import { ensureSeeded, getQuotes } from "@/lib/market";
import { and, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/instruments?q=&exchange=&segment=&sector=&fno=1&minPrice=&maxPrice=&minChange=&maxChange=&sort=&dir=&limit=
 * Stock finder / screener with live (simulated) quotes merged in.
 */
export async function GET(req: NextRequest) {
  await ensureSeeded();
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q")?.trim();
  const exchange = sp.get("exchange");
  const segment = sp.get("segment");
  const sector = sp.get("sector");
  const fno = sp.get("fno");
  const minPrice = Number(sp.get("minPrice") || 0);
  const maxPrice = Number(sp.get("maxPrice") || 0);
  const minChange = sp.get("minChange") ? Number(sp.get("minChange")) : null;
  const maxChange = sp.get("maxChange") ? Number(sp.get("maxChange")) : null;
  const sort = sp.get("sort") || "symbol";
  const dir = sp.get("dir") === "desc" ? -1 : 1;
  const limit = Math.min(Number(sp.get("limit") || 500), 1000);

  const conds: SQL[] = [];
  if (q) conds.push(or(ilike(instruments.symbol, `%${q}%`), ilike(instruments.name, `%${q}%`))!);
  if (exchange && exchange !== "ALL") conds.push(eq(instruments.exchange, exchange));
  if (segment && segment !== "ALL") conds.push(eq(instruments.segment, segment));
  if (sector && sector !== "ALL") conds.push(eq(instruments.sector, sector));
  if (fno === "1") conds.push(eq(instruments.isFno, true));

  const rows = await db
    .select()
    .from(instruments)
    .where(conds.length ? and(...conds) : undefined)
    .limit(1000);

  const liveQuotes = await getQuotes(rows.map((r) => r.symbol));
  let out = rows.map((r) => {
    const quote = liveQuotes[r.symbol];
    return { ...r, quote };
  });
  if (minPrice > 0) out = out.filter((r) => r.quote.ltp >= minPrice);
  if (maxPrice > 0) out = out.filter((r) => r.quote.ltp <= maxPrice);
  if (minChange != null) out = out.filter((r) => r.quote.changePct >= minChange);
  if (maxChange != null) out = out.filter((r) => r.quote.changePct <= maxChange);

  out.sort((a, b) => {
    const va = sort === "ltp" ? a.quote.ltp : sort === "changePct" ? a.quote.changePct : sort === "volume" ? a.quote.volume : sort === "marketCap" ? a.marketCap : sort === "pe" ? a.pe : a.symbol;
    const vb = sort === "ltp" ? b.quote.ltp : sort === "changePct" ? b.quote.changePct : sort === "volume" ? b.quote.volume : sort === "marketCap" ? b.marketCap : sort === "pe" ? b.pe : b.symbol;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  const sectors = await db.selectDistinct({ sector: instruments.sector }).from(instruments).orderBy(instruments.sector);
  return Response.json({ count: out.length, items: out.slice(0, limit), sectors: sectors.map((s) => s.sector) });
}

/** POST /api/instruments — add custom instrument */
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.symbol || !b.name || !b.basePrice) return Response.json({ error: "symbol, name, basePrice required" }, { status: 400 });
  const [row] = await db
    .insert(instruments)
    .values({
      symbol: String(b.symbol).toUpperCase(),
      name: b.name,
      exchange: b.exchange || "NSE",
      segment: b.segment || "EQ",
      sector: b.sector || "Other",
      lotSize: Number(b.lotSize) || 1,
      basePrice: Number(b.basePrice),
      isFno: !!b.isFno,
      volatility: Number(b.volatility) || 0.25,
      high52: Number(b.basePrice) * 1.25,
      low52: Number(b.basePrice) * 0.75,
    })
    .onConflictDoUpdate({
      target: instruments.symbol,
      set: { name: b.name, basePrice: Number(b.basePrice), exchange: b.exchange || "NSE", segment: b.segment || "EQ", sector: b.sector || "Other", lotSize: Number(b.lotSize) || 1, isFno: !!b.isFno },
    })
    .returning();
  return Response.json(row, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });
  await db.delete(instruments).where(sql`${instruments.symbol} = ${symbol}`);
  return Response.json({ ok: true });
}
