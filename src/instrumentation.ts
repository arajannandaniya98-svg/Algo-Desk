/**
 * Runs once when the Next.js server starts (npm start / next dev).
 * Auto-creates the PostgreSQL database + tables so a fresh install only needs
 * a running PostgreSQL server and DATABASE_URL in .env — no manual migration.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { ensureDatabase } = await import("@/lib/db-init");
    const r = await ensureDatabase({ retries: 3 });
    console.log(`[AlgoDesk] ${r.message}`);
    for (const w of r.warnings) console.warn(`[AlgoDesk] schema warning: ${w}`);
    const { bootstrapSecurity } = await import("@/lib/security/bootstrap");
    await bootstrapSecurity();
    const { autoStartFeed } = await import("@/lib/feed/control");
    await autoStartFeed().catch((e: Error) => console.error(`[AlgoDesk] Live feed auto-start failed: ${e.message}`));
    const { attachTickEngine } = await import("@/lib/engine");
    const { feedHub } = await import("@/lib/feed/hub");
    attachTickEngine(feedHub()); // crypto (Delta) tick engine works even without a broker feed
  } catch (e) {
    console.error(`[AlgoDesk] Database auto-setup failed: ${(e as Error).message}`);
    console.error("[AlgoDesk] After fixing PostgreSQL / DATABASE_URL, restart the app (it retries) or use Admin & Security → Security Checklist → Repair database.");
  }
}
