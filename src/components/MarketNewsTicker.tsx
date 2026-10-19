"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./utils";
import type { MarketNewsItem } from "@/app/api/news/route";

type NewsLang = "gu" | "hi" | "en";

export function MarketNewsTicker({ onSelectSymbol }: { onSelectSymbol?: (symbol: string) => void }) {
  const [items, setItems] = useState<MarketNewsItem[]>([]);
  const [lang, setLang] = useState<NewsLang>("gu");
  const [paused, setPaused] = useState(false);
  const [selectedNews, setSelectedNews] = useState<MarketNewsItem | null>(null);
  const [showAllModal, setShowAllModal] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("algodesk.newsLang") as NewsLang | null;
    if (saved && ["gu", "hi", "en"].includes(saved)) {
      setLang(saved);
    }
  }, []);

  const changeLang = (l: NewsLang) => {
    setLang(l);
    localStorage.setItem("algodesk.newsLang", l);
  };

  const loadNews = useCallback(async () => {
    try {
      const res = await api<{ items: MarketNewsItem[] }>("/api/news");
      if (res.items) setItems(res.items);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadNews();
    const id = setInterval(loadNews, 30000);
    return () => clearInterval(id);
  }, [loadNews]);

  const getTitle = (it: MarketNewsItem) => {
    if (lang === "gu") return it.titleGu;
    if (lang === "hi") return it.titleHi;
    return it.titleEn;
  };

  const getSummary = (it: MarketNewsItem) => {
    if (lang === "gu") return it.summaryGu;
    if (lang === "hi") return it.summaryHi;
    return it.summaryEn;
  };

  if (items.length === 0) return null;

  return (
    <div className="panel overflow-hidden border-sky-500/30 bg-[#0b1322]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        {/* Live Breaking News Badge */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-ping" />
          <span className="text-[11px] font-black uppercase tracking-wider text-sky-300 bg-sky-500/15 px-2 py-0.5 rounded border border-sky-500/30">
            📰 માર્કેટ સમાચાર · LIVE NEWS
          </span>
        </div>

        {/* Scrolling Marquee Container */}
        <div
          className="flex-1 min-w-[200px] overflow-hidden relative py-0.5"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div
            className="flex items-center gap-8 whitespace-nowrap"
            style={{
              animation: "algodeskMarquee 42s linear infinite",
              animationPlayState: paused ? "paused" : "running",
              width: "max-content",
            }}
          >
            {[...items, ...items].map((it, idx) => (
              <button
                key={`${it.id}-${idx}`}
                type="button"
                onClick={() => setSelectedNews(it)}
                className="inline-flex items-center gap-2 text-xs hover:text-sky-300 transition cursor-pointer group"
                title="Click to read full news in Gujarati & Hindi"
              >
                <span
                  className={`badge text-[9px] font-black ${
                    it.sentiment === "BULLISH"
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                      : it.sentiment === "BEARISH"
                      ? "bg-red-500/20 text-red-300 border border-red-500/30"
                      : "bg-slate-700 text-slate-300"
                  }`}
                >
                  {it.symbol}
                </span>
                <span className="text-slate-100 font-medium group-hover:underline">
                  {getTitle(it)}
                </span>
                <span className="text-[10px] text-slate-500 mono">({it.timeAgo})</span>
                <span className="text-slate-600">•</span>
              </button>
            ))}
          </div>
        </div>

        {/* Language Switcher (Gujarati / Hindi / English) & Controls */}
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <div className="flex items-center bg-[#070c16] p-0.5 rounded-lg border border-[#1f2937]">
            <button
              type="button"
              onClick={() => changeLang("gu")}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition ${
                lang === "gu" ? "bg-sky-500 text-slate-950" : "text-slate-400 hover:text-white"
              }`}
              title="ગુજરાતીમાં વાંચો"
            >
              ગુજરાતી
            </button>
            <button
              type="button"
              onClick={() => changeLang("hi")}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition ${
                lang === "hi" ? "bg-sky-500 text-slate-950" : "text-slate-400 hover:text-white"
              }`}
              title="हिंदी में पढ़ें"
            >
              हिंदी
            </button>
            <button
              type="button"
              onClick={() => changeLang("en")}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition ${
                lang === "en" ? "bg-sky-500 text-slate-950" : "text-slate-400 hover:text-white"
              }`}
              title="Read in English"
            >
              EN
            </button>
          </div>

          <button
            type="button"
            className="btn btn-xs py-0.5 px-2"
            onClick={() => setPaused(!paused)}
            title={paused ? "Resume Scrolling" : "Pause Scrolling"}
          >
            {paused ? "▶" : "⏸"}
          </button>

          <button
            type="button"
            className="btn btn-xs py-0.5 px-2 bg-[#172338] text-sky-300 border-sky-500/30 font-bold"
            onClick={() => setShowAllModal(true)}
            title="View All News in Gujarati & Hindi"
          >
            📋 બધા સમાચાર
          </button>
        </div>
      </div>

      {/* Keyframe style for smooth marquee */}
      <style jsx>{`
        @keyframes algodeskMarquee {
          0% {
            transform: translateX(0%);
          }
          100% {
            transform: translateX(-50%);
          }
        }
      `}</style>

      {/* Single News Reader Modal (Gujarati + Hindi + English simultaneously) */}
      {selectedNews && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setSelectedNews(null)}
        >
          <div
            className="panel w-full max-w-2xl p-5 bg-[#0d1424] border-sky-500/40 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 border-b border-[#1f2937] pb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`badge font-black ${
                    selectedNews.sentiment === "BULLISH"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : selectedNews.sentiment === "BEARISH"
                      ? "bg-red-500/20 text-red-300"
                      : "bg-slate-700 text-slate-300"
                  }`}
                >
                  {selectedNews.sentiment} · {selectedNews.symbol}
                </span>
                <span className="text-xs text-slate-400">
                  {selectedNews.source} · {selectedNews.timeAgo}
                </span>
              </div>
              <button className="btn btn-xs" onClick={() => setSelectedNews(null)}>
                ✕
              </button>
            </div>

            {/* Gujarati Section */}
            <div className="rounded-lg border border-sky-500/30 bg-[#08101d] p-3.5 space-y-1.5">
              <div className="text-[10px] font-bold uppercase text-sky-400">🇮🇳 ગુજરાતી (Gujarati)</div>
              <div className="text-sm font-bold text-white leading-snug">{selectedNews.titleGu}</div>
              <p className="text-xs text-slate-300 leading-relaxed">{selectedNews.summaryGu}</p>
            </div>

            {/* Hindi Section */}
            <div className="rounded-lg border border-amber-500/30 bg-[#08101d] p-3.5 space-y-1.5">
              <div className="text-[10px] font-bold uppercase text-amber-400">🇮🇳 हिंदी (Hindi)</div>
              <div className="text-sm font-bold text-white leading-snug">{selectedNews.titleHi}</div>
              <p className="text-xs text-slate-300 leading-relaxed">{selectedNews.summaryHi}</p>
            </div>

            {/* English Section */}
            <div className="rounded-lg border border-[#1f2937] bg-[#08101d] p-3 space-y-1">
              <div className="text-[10px] font-bold uppercase text-slate-400">🌐 English</div>
              <div className="text-xs font-bold text-slate-200">{selectedNews.titleEn}</div>
              <p className="text-[11px] text-slate-400">{selectedNews.summaryEn}</p>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[#1f2937]">
              {onSelectSymbol && (
                <button
                  className="btn btn-xs btn-primary font-bold"
                  onClick={() => {
                    onSelectSymbol(selectedNews.symbol);
                    setSelectedNews(null);
                  }}
                >
                  📈 Open {selectedNews.symbol} Chart
                </button>
              )}
              <button className="btn btn-xs ml-auto" onClick={() => setSelectedNews(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* All News Feed Modal */}
      {showAllModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setShowAllModal(false)}
        >
          <div
            className="panel w-full max-w-4xl p-5 bg-[#0d1424] border-sky-500/40 max-h-[88vh] overflow-y-auto space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1f2937] pb-3">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  📰 લાઈવ માર્કેટ સમાચાર (ગુજરાતી · हिंदी · English)
                </h2>
                <p className="text-xs text-slate-400">
                  Live Indian Stock Market, Options Chain, Commodities &amp; Crypto Updates
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {(["gu", "hi", "en"] as const).map((l) => (
                  <button
                    key={l}
                    className={`btn btn-xs ${lang === l ? "btn-primary font-bold" : ""}`}
                    onClick={() => changeLang(l)}
                  >
                    {l === "gu" ? "ગુજરાતી" : l === "hi" ? "हिंदी" : "English"}
                  </button>
                ))}
                <button className="btn btn-xs ml-2" onClick={() => setShowAllModal(false)}>
                  ✕
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {items.map((it) => (
                <div
                  key={it.id}
                  className="rounded-lg border border-[#223049] bg-[#08101d] p-3.5 space-y-2 hover:border-sky-500/40 transition"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`badge font-black ${
                          it.sentiment === "BULLISH"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : it.sentiment === "BEARISH"
                            ? "bg-red-500/20 text-red-300"
                            : "bg-slate-700 text-slate-300"
                        }`}
                      >
                        {it.symbol} · {it.sentiment}
                      </span>
                      <span className="text-[11px] text-slate-400">{it.source}</span>
                    </div>
                    <span className="text-[11px] text-slate-500 mono">{it.timeAgo}</span>
                  </div>

                  <div className="text-sm font-bold text-white">{getTitle(it)}</div>
                  <p className="text-xs text-slate-300 leading-relaxed">{getSummary(it)}</p>

                  {lang !== "gu" && (
                    <div className="text-[11px] text-sky-300/90 pt-1 border-t border-[#162235]">
                      <b>ગુજરાતી:</b> {it.titleGu}
                    </div>
                  )}
                  {lang !== "hi" && (
                    <div className="text-[11px] text-amber-300/90 pt-1 border-t border-[#162235]">
                      <b>हिंदी:</b> {it.titleHi}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
