"use client";

import { useEffect, useState } from "react";

type T = { id: number; msg: string; kind: "success" | "error" | "info" };
let counter = 0;

export function toast(msg: string, kind: T["kind"] = "info") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { id: ++counter, msg, kind } }));
}

export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent<T>).detail;
      setItems((s) => [...s, t]);
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== t.id)), 4500);
    };
    window.addEventListener("app-toast", h);
    return () => window.removeEventListener("app-toast", h);
  }, []);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg border px-4 py-2.5 text-sm shadow-xl backdrop-blur ${
            t.kind === "success"
              ? "bg-green-500/15 border-green-500/40 text-green-200"
              : t.kind === "error"
                ? "bg-red-500/15 border-red-500/40 text-red-200"
                : "bg-sky-500/15 border-sky-500/40 text-sky-100"
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
