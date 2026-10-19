import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { Toaster } from "@/components/Toast";
import { AIChat } from "@/components/AIChat";

export const metadata: Metadata = {
  title: "AlgoDesk India — Algo Trading Terminal",
  description: "Indian market algo trading: stocks, options chain, all segments, Dhan / Angel One / Kotak Neo",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen">
        <div className="flex min-h-screen">
          <Nav />
          <main className="flex-1 min-w-0 p-4 md:p-6">{children}<AIChat /></main> 
        </div>
        <Toaster />
      </body>
    </html>
  );
}
