import { db } from "@/db";
import { brokers, orders, setups } from "@/db/schema";
import { currentPrice, computePnl } from "@/lib/engine";
import { getQuotes } from "@/lib/market";
import { capitalSnapshot } from "@/lib/capital";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const [allSetups, recentOrders, allBrokers, indices] = await Promise.all([
    db.select().from(setups).orderBy(desc(setups.updatedAt)),
    db.select().from(orders).orderBy(desc(orders.id)).limit(10),
    db.select().from(brokers),
    getQuotes([
      "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "INDIAVIX",
      "GOLD", "SILVER", "CRUDEOIL", "NATURALGAS", "COPPER", "USDINR", "EURINR", "GBPINR", "JPYINR",
      "BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "BNBUSD"
    ]),
  ]);

  const open = allSetups.filter((s) => s.status === "ENTERED");
  const positions = await Promise.all(
    open.map(async (s) => {
      const ltp = (await currentPrice(s)) ?? s.entryFilledPrice ?? 0;
      return { ...s, ltp, unrealized: computePnl(s, ltp) };
    }),
  );
  const realized = allSetups.filter((s) => s.status === "EXITED").reduce((a, s) => a + s.pnl, 0);
  const unrealized = positions.reduce((a, p) => a + p.unrealized, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayPnl = allSetups.filter((s) => s.status === "EXITED" && s.exitAt && s.exitAt >= today).reduce((a, s) => a + s.pnl, 0);

  const capital = await capitalSnapshot();
  return Response.json({
    capital,
    stats: {
      total: allSetups.length,
      active: allSetups.filter((s) => s.status === "ACTIVE").length,
      entered: open.length,
      exited: allSetups.filter((s) => s.status === "EXITED").length,
      realized: +realized.toFixed(2),
      unrealized: +unrealized.toFixed(2),
      todayPnl: +todayPnl.toFixed(2),
      brokers: allBrokers.length,
      liveBrokers: allBrokers.filter((b) => b.mode === "live").length,
      wins: allSetups.filter((s) => s.status === "EXITED" && s.pnl > 0).length,
      losses: allSetups.filter((s) => s.status === "EXITED" && s.pnl < 0).length,
    },
    positions,
    watching: allSetups.filter((s) => s.status === "ACTIVE").slice(0, 10),
    recentOrders,
    indices,
  });
}
