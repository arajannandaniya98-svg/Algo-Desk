import { getQuotes } from "@/lib/market";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/quotes?symbols=NIFTY,RELIANCE */
export async function GET(req: NextRequest) {
  const symbols = (req.nextUrl.searchParams.get("symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const quotes = await getQuotes(symbols);
  return Response.json(quotes);
}
