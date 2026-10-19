"use client";

import { useEffect, useRef, memo } from "react";

interface TradingViewWidgetProps {
  symbol: string;
  theme?: "dark" | "light";
  autosize?: boolean;
  height?: number | string;
  interval?: string;
  timezone?: string;
}

/**
 * Maps app symbols to TradingView symbols:
 * - Indian Indices: NSE:NIFTY, BSE:SENSEX, NSE:BANKNIFTY, etc.
 * - Indian Equities: NSE:RELIANCE, NSE:TCS, etc.
 * - Crypto: BINANCE:BTCUSDT, BINANCE:ETHUSDT, DELTA:BTCUSD (or CRYPTO:BTCUSD)
 * - Commodities: MCX:GOLD1!, MCX:CRUDEOIL1! or TV equivalents
 * - Currencies: FX_IDC:USDINR
 */
export function mapToTradingViewSymbol(sym: string): string {
  const clean = sym.trim().toUpperCase();

  // Common Indian Indices
  const indexMap: Record<string, string> = {
    NIFTY: "NSE:NIFTY",
    NIFTY50: "NSE:NIFTY",
    BANKNIFTY: "NSE:BANKNIFTY",
    NIFTYBANK: "NSE:BANKNIFTY",
    FINNIFTY: "NSE:FINNIFTY",
    MIDCPNIFTY: "NSE:MIDCPNIFTY",
    NIFTYNXT50: "NSE:NIFTYNXT50",
    SENSEX: "BSE:SENSEX",
    BANKEX: "BSE:BANKEX",
    INDIAVIX: "NSE:INDIAVIX",
  };
  if (indexMap[clean]) return indexMap[clean];

  // Crypto perpetuals / spot
  if (clean === "BTCUSD" || clean === "BTCUSDT") return "BINANCE:BTCUSDT";
  if (clean === "ETHUSD" || clean === "ETHUSDT") return "BINANCE:ETHUSDT";
  if (clean === "SOLUSD" || clean === "SOLUSDT") return "BINANCE:SOLUSDT";
  if (clean === "XRPUSD" || clean === "XRPUSDT") return "BINANCE:XRPUSDT";
  if (clean === "BNBUSD" || clean === "BNBUSDT") return "BINANCE:BNBUSDT";
  if (clean === "DOGEUSD" || clean === "DOGEUSDT") return "BINANCE:DOGEUSDT";
  if (clean === "ADAUSD" || clean === "ADAUSDT") return "BINANCE:ADAUSDT";
  if (clean === "AVAXUSD" || clean === "AVAXUSDT") return "BINANCE:AVAXUSDT";
  if (clean === "LINKUSD" || clean === "LINKUSDT") return "BINANCE:LINKUSDT";
  if (clean === "LTCUSD" || clean === "LTCUSDT") return "BINANCE:LTCUSDT";
  if (clean === "TRXUSD" || clean === "TRXUSDT") return "BINANCE:TRXUSDT";
  if (clean === "DOTUSD" || clean === "DOTUSDT") return "BINANCE:DOTUSDT";
  if (clean === "UNIUSD" || clean === "UNIUSDT") return "BINANCE:UNIUSDT";
  if (clean === "XLMUSD" || clean === "XLMUSDT") return "BINANCE:XLMUSDT";
  if (clean === "WLDUSD" || clean === "WLDUSDT") return "BINANCE:WLDUSDT";

  // Commodities (MCX)
  if (clean === "GOLD" || clean === "GOLDM") return "MCX:GOLD1!";
  if (clean === "SILVER" || clean === "SILVERM") return "MCX:SILVER1!";
  if (clean === "CRUDEOIL" || clean === "CRUDEOILM") return "MCX:CRUDEOIL1!";
  if (clean === "NATURALGAS") return "MCX:NATURALGAS1!";
  if (clean === "COPPER") return "MCX:COPPER1!";

  // Currencies
  if (clean === "USDINR") return "FX_IDC:USDINR";
  if (clean === "EURINR") return "FX_IDC:EURINR";
  if (clean === "GBPINR") return "FX_IDC:GBPINR";
  if (clean === "JPYINR") return "FX_IDC:JPYINR";

  // Option contracts fallback to underlying index
  if (clean.includes("NIFTY") && (clean.includes("CE") || clean.includes("PE"))) return "NSE:NIFTY";
  if (clean.includes("BANKNIFTY") && (clean.includes("CE") || clean.includes("PE"))) return "NSE:BANKNIFTY";
  if (clean.includes("SENSEX") && (clean.includes("CE") || clean.includes("PE"))) return "BSE:SENSEX";
  if (clean.startsWith("C-BTC") || clean.startsWith("P-BTC")) return "BINANCE:BTCUSDT";
  if (clean.startsWith("C-ETH") || clean.startsWith("P-ETH")) return "BINANCE:ETHUSDT";

  // Default: assume NSE Equity if none matched
  if (clean.includes(":")) return clean;
  return `NSE:${clean}`;
}

function TradingViewWidgetComponent({
  symbol,
  theme = "dark",
  autosize = true,
  height = 560,
  interval = "15",
  timezone = "Asia/Kolkata",
}: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const tvSymbol = mapToTradingViewSymbol(symbol);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Clear previous widget
    container.innerHTML = "";

    const widgetContainer = document.createElement("div");
    widgetContainer.className = "tradingview-widget-container__widget";
    widgetContainer.style.height = typeof height === "number" ? `${height}px` : height;
    widgetContainer.style.width = "100%";
    container.appendChild(widgetContainer);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;

    // Advanced TradingView Chart configuration with full drawing tools, SMC, all indicators
    const config = {
      autosize: autosize,
      symbol: tvSymbol,
      interval: interval,
      timezone: timezone,
      theme: theme,
      style: "1", // 1 = Candles
      locale: "in",
      enable_publishing: false,
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: true,
      calendar: false,
      hide_volume: false,
      support_host: "https://www.tradingview.com",
      withdateranges: true,
      range: "YTD",
      allow_symbol_change: true,
      details: true,
      hotlist: false,
      // Built-in popular indicators pre-loaded (Volume is automatic, add EMA/MACD)
      studies: [
        "STD;EMA",
        "STD;MACD",
      ],
      container_id: "tradingview_advanced_chart",
    };

    script.innerHTML = JSON.stringify(config);
    container.appendChild(script);

    return () => {
      if (container) {
        container.innerHTML = "";
      }
    };
  }, [tvSymbol, interval, theme, height, autosize, timezone]);

  return (
    <div
      className="tradingview-widget-container w-full relative"
      ref={containerRef}
      style={{ height: typeof height === "number" ? `${height}px` : height }}
    >
      <div className="flex items-center justify-center h-full text-xs text-slate-500">
        Loading TradingView Advanced Chart for {tvSymbol}…
      </div>
    </div>
  );
}

export const TradingViewWidget = memo(TradingViewWidgetComponent);
