"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "./Toast";

type Role = "admin" | "trader" | "viewer";
type Me = { username: string; displayName: string; role: Role; mustChangePassword: boolean; totpEnabled: boolean };
type FeedMini = { state: string; provider: string | null; ticksPerSec: number; simulated: boolean };

const LINKS: { href: string; label: string; icon: string; roles?: Role[] }[] = [
  { href: "/", label: "Dashboard", icon: "▦" },
  { href: "/watchlist", label: "Watchlist", icon: "⭐" },
  { href: "/live", label: "Live Feed", icon: "⚡" },
  { href: "/signals", label: "Signals", icon: "◎" },
  { href: "/stocks", label: "Stock Finder", icon: "⌕" },
  { href: "/options", label: "Options Chain", icon: "⛓" },
  { href: "/strategy", label: "Strategy Builder", icon: "◈" },
  { href: "/setups", label: "Algo Setups", icon: "⚙" },
  { href: "/orders", label: "Orders", icon: "☰" },
  { href: "/brokers", label: "Brokers", icon: "🔌" },
  { href: "/admin", label: "Admin & Security", icon: "🛡" },
];
const ROLE_BADGE: Record<Role, string> = { admin: "bg-red-500/20 text-red-300", trader: "bg-sky-500/20 text-sky-300", viewer: "bg-slate-600/30 text-slate-300" };

export function Nav() {
  const path = usePathname();
  const onLogin = path === "/login";
  const [me, setMe] = useState<Me | null>(null);
  const [engineOn, setEngineOn] = useState(true);
  const [lastTick, setLastTick] = useState("");
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<FeedMini | null>(null);

  useEffect(() => {
    if (onLogin) return;
    fetch("/api/auth")
      .then((r) => r.json())
      .then((j: { user?: Me | null }) => setMe(j.user ?? null))
      .catch(() => {});
  }, [onLogin]);

  useEffect(() => {
    if (onLogin || !me) return;
    const load = () =>
      fetch("/api/feed")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { status?: FeedMini } | null) => j?.status && setFeed(j.status))
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [onLogin, me]);

  const canTrade = me?.role === "admin" || me?.role === "trader";

  // Poll engine (entry triggers / SL / target) every 5s + show tick-engine events
  useEffect(() => {
    if (!engineOn || onLogin || !canTrade) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/engine", { method: "POST" });
        if (!r.ok) return;
        const j = (await r.json()) as { events?: { event: string; name: string; price: number; origin?: string }[] };
        if (stop) return;
        setLastTick(new Date().toLocaleTimeString("en-IN", { hour12: false }));
        for (const ev of j.events ?? []) {
          toast(`${ev.origin === "TICK" ? "⚡ " : ""}${ev.event} — ${ev.name} @ ₹${ev.price}`, ev.event.includes("FAILED") || ev.event === "STOPLOSS" ? "error" : "success");
        }
        window.dispatchEvent(new CustomEvent("engine-tick", { detail: j }));
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [engineOn, onLogin, canTrade]);

  if (onLogin) return null;

  const logout = async () => {
    await fetch("/api/auth", { method: "DELETE" }).catch(() => {});
    window.location.href = "/login";
  };
  const links = LINKS.filter((l) => !l.roles || (me && l.roles.includes(me.role)));
  const liveFeed = feed?.state === "connected" && !feed.simulated;

  return (
    <>
      <button className="md:hidden fixed top-3 left-3 z-40 btn btn-xs" onClick={() => setOpen(!open)}>
        ☰
      </button>
      <aside
        className={`${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0 fixed md:sticky top-0 z-30 h-screen w-60 shrink-0 border-r border-[#1f2937] bg-[#0d1320] p-4 flex flex-col transition-transform overflow-y-auto`}
      >
        <div className="mb-5 px-2">
          <div className="text-lg font-black tracking-tight">
            <span className="text-sky-400">Algo</span>Desk <span className="text-xs font-semibold text-slate-400 align-top">IN</span>
          </div>
          <div className="text-[11px] text-slate-500">NSE · BSE · NFO · MCX · CDS</div>
        </div>
        <nav className="flex flex-col gap-1">
          {links.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            const label = l.href === "/admin" && me?.role !== "admin" ? "My Account" : l.label;
            return (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active ? "bg-sky-500/15 text-sky-300 border border-sky-500/30" : "text-slate-300 hover:bg-white/5 border border-transparent"
                }`}
              >
                <span className="w-5 text-center text-base">{l.icon}</span>
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-2 pt-4">
          <Link href="/live" className="block panel p-2.5 text-xs hover:border-sky-500/40">
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${liveFeed ? "bg-emerald-400 animate-pulse" : feed?.state === "connected" ? "bg-amber-400" : "bg-slate-500"}`} />
              <span className="font-semibold">{liveFeed ? `LIVE · ${feed?.provider === "dhan" ? "Dhan" : "Angel"}` : feed?.state === "connected" ? "DEMO feed" : "Feed off · Yahoo 15m"}</span>
            </div>
            {feed?.state === "connected" && <div className="text-[10px] text-slate-500 mt-0.5">{feed.ticksPerSec} ticks/s</div>}
          </Link>

          {canTrade && (
            <div className="panel p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Algo Engine</span>
                <button onClick={() => setEngineOn(!engineOn)} className={`relative h-5 w-9 rounded-full transition ${engineOn ? "bg-green-500" : "bg-slate-600"}`} aria-label="toggle engine">
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${engineOn ? "left-4.5 translate-x-4" : "left-0.5"}`} />
                </button>
              </div>
              <div className="mt-1 text-[10px] text-slate-400">{engineOn ? `Poll 5s · ${lastTick || "…"}${liveFeed ? " · ⚡ tick engine ON" : ""}` : "Paused"}</div>
            </div>
          )}

          {me && (
            <div className="panel p-2.5 text-xs">
              <div className="flex items-center justify-between gap-1">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{me.displayName || me.username}</div>
                  <div className="text-[10px] text-slate-500 mono truncate">@{me.username}</div>
                </div>
                <span className={`badge ${ROLE_BADGE[me.role]}`}>{me.role}</span>
              </div>
              <div className="flex items-center justify-between mt-2">
                <Link href="/admin?tab=account" className={`text-[10px] ${me.totpEnabled ? "text-emerald-400" : "text-amber-300"}`}>
                  {me.totpEnabled ? "🔐 2FA on" : "⚠ Enable 2FA"}
                </Link>
                <button className="btn btn-xs" onClick={logout}>
                  Logout
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
