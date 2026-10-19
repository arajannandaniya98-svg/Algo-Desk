"use client";

import { useCallback, useEffect, useState } from "react";
import type { Order } from "@/db/schema";
import { api, fmt, statusColor, providerName } from "@/components/utils";
import { toast } from "@/components/Toast";

export default function OrdersPage() {
  const [rows, setRows] = useState<Order[]>([]);
  const [filter, setFilter] = useState("ALL");
  const load = useCallback(() => api<Order[]>("/api/orders?limit=500").then(setRows).catch(() => {}), []);
  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    window.addEventListener("engine-tick", load);
    return () => {
      clearInterval(id);
      window.removeEventListener("engine-tick", load);
    };
  }, [load]);

  const clear = async () => {
    if (!confirm("Clear entire order log?")) return;
    await api("/api/orders", { method: "DELETE" });
    toast("Order log cleared", "info");
    load();
  };

  const shown = rows.filter((r) => filter === "ALL" || r.status === filter || r.action === filter || r.mode === filter.toLowerCase());
  const exportCsv = () => {
    const head = ["id", "time", "provider", "mode", "symbol", "exchange", "action", "side", "qty", "type", "product", "price", "filled", "status", "brokerOrderId", "message"];
    const lines = shown.map((o) => [o.id, new Date(o.createdAt).toISOString(), o.provider, o.mode, o.symbol, o.exchange, o.action, o.side, o.quantity, o.orderType, o.productType, o.price, o.filledPrice ?? "", o.status, o.brokerOrderId, `"${o.message.replace(/"/g, "'")}"`].join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `orders-${Date.now()}.csv`;
    a.click();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">Order Book</h1>
          <p className="text-xs text-slate-400">Every entry / exit sent to a broker or the paper simulator</p>
        </div>
        <div className="flex gap-2">
          <select className="input w-40" value={filter} onChange={(e) => setFilter(e.target.value)}>
            {["ALL", "FILLED", "PENDING", "REJECTED", "ENTRY", "EXIT", "PAPER", "LIVE"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <button className="btn" onClick={exportCsv}>
            ⤓ CSV
          </button>
          <button className="btn" onClick={clear}>
            Clear
          </button>
        </div>
      </div>
      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Broker</th>
              <th>Symbol</th>
              <th>Action</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Type</th>
              <th>Price</th>
              <th>Filled</th>
              <th>Status</th>
              <th>Broker Order ID</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.id}>
                <td className="mono text-slate-500">{o.id}</td>
                <td className="mono text-xs">{new Date(o.createdAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "medium" })}</td>
                <td className="text-xs">
                  {providerName[o.provider] ?? o.provider} <span className={`badge ${o.mode === "live" ? "bg-red-500/20 text-red-300" : "bg-slate-700/50 text-slate-300"}`}>{o.mode}</span>
                </td>
                <td className="mono font-semibold">
                  {o.symbol} <span className="text-[10px] text-slate-500">{o.exchange}</span>
                </td>
                <td className="text-xs">{o.action}</td>
                <td className={`font-bold ${o.side === "BUY" ? "up" : "down"}`}>{o.side}</td>
                <td className="mono">{o.quantity}</td>
                <td className="text-xs">
                  {o.orderType} / {o.productType}
                </td>
                <td className="mono">{fmt(o.price)}</td>
                <td className="mono">{fmt(o.filledPrice)}</td>
                <td>
                  <span className={`badge ${statusColor[o.status]}`}>{o.status}</span>
                </td>
                <td className="mono text-[11px] text-slate-400">{o.brokerOrderId || "—"}</td>
                <td className="text-[11px] text-slate-400 max-w-[280px] truncate" title={o.message}>
                  {o.message}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={13} className="text-center text-slate-500 py-10">
                  No orders yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
