"use client";

import { useEffect, useRef, useState, useMemo, memo } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type IPriceLine,
} from "lightweight-charts";
import {
  ema as calcEma,
  vwap as calcVwap,
  rsi as calcRsi,
  type Candle,
} from "@/lib/indicators";

import { evaluateFormula, type PineStyleIndicator } from "@/lib/custom-indicator";

interface TradingViewCanvasChartProps {
  symbol: string;
  candles: Candle[];
  livePrice?: number | null;
  height?: number;
  levels?: {
    stopLoss?: number;
    target?: number;
    support?: number;
    resistance?: number;
    entry?: number;
    trailingSl?: number;
    tradeSide?: string;
    tradeQty?: number;
  } | null;
  currency?: string;
  showIndicators?: boolean;
  customPineIndicators?: PineStyleIndicator[];
}

function TradingViewCanvasChartComponent({
  symbol,
  candles,
  livePrice,
  height = 560,
  levels,
  currency = "₹",
  showIndicators = true,
  customPineIndicators = [],
}: TradingViewCanvasChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rsiContainerRef = useRef<HTMLDivElement>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const priceLinesRef = useRef<IPriceLine[]>([]);
  const customSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const isFirstLoadRef = useRef(true);

  // Toggleable indicator overlays
  const [showEma9, setShowEma9] = useState(true);
  const [showEma21, setShowEma21] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [showRsi, setShowRsi] = useState(false);
  const [showLevels, setShowLevels] = useState(true);

  // Crosshair live readout
  const [legendData, setLegendData] = useState<{
    time?: string;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    change?: number;
    changePct?: number;
  } | null>(null);

  // Prepare sanitized, deduplicated candle and volume data (lightweight-charts requires strictly ascending integer timestamps)
  const preparedData = useMemo(() => {
    if (!candles || candles.length < 2) return { candleData: [], volData: [], lastTime: 0 };

    const candleData: { time: UTCTimestamp; open: number; high: number; low: number; close: number }[] = [];
    const volData: { time: UTCTimestamp; value: number; color: string }[] = [];

    let lastSec = 0;
    for (const c of candles) {
      if (!c || !Number.isFinite(c.c) || c.c <= 0) continue;
      const sec = Math.floor(c.t / 1000) as UTCTimestamp;
      if (sec > lastSec) {
        candleData.push({
          time: sec,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
        });
        volData.push({
          time: sec,
          value: c.v || 0,
          color: c.c >= c.o ? "rgba(34, 197, 94, 0.4)" : "rgba(239, 68, 68, 0.4)",
        });
        lastSec = sec;
      }
    }

    return { candleData, volData, lastTime: lastSec };
  }, [candles]);

  // 1. Main Chart Setup (Runs ONCE when symbol, height, or showRsi changes — NEVER on data update)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Reset flag for fitContent on new symbol
    isFirstLoadRef.current = true;

    // Clean up previous instance
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const mainChartHeight = showRsi ? Math.max(260, height - 120) : height;

    const chart = createChart(container, {
      width: container.clientWidth || 800,
      height: mainChartHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0f17" },
        textColor: "#94a3b8",
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      },
      grid: {
        vertLines: { color: "rgba(30, 41, 59, 0.6)" },
        horzLines: { color: "rgba(30, 41, 59, 0.6)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "#64748b",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1e293b",
        },
        horzLine: {
          color: "#64748b",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1e293b",
        },
      },
      rightPriceScale: {
        borderColor: "#1f2937",
        scaleMargins: {
          top: 0.08,
          bottom: 0.18,
        },
        autoScale: true,
      },
      timeScale: {
        borderColor: "#1f2937",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 9,
        minBarSpacing: 2,
        rightOffset: 12,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    chartRef.current = chart;

    // Candlestick Series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "price",
        precision: symbol.endsWith("USD") && !symbol.startsWith("BTC") ? 4 : 2,
        minMove: symbol.endsWith("USD") && !symbol.startsWith("BTC") ? 0.0001 : 0.05,
      },
    });
    candleSeriesRef.current = candleSeries;

    // Volume Series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    // EMA 9 Series
    const ema9Series = chart.addSeries(LineSeries, {
      color: "#38bdf8",
      lineWidth: 1,
      priceLineVisible: false,
      title: "EMA 9",
    });
    ema9SeriesRef.current = ema9Series;

    // EMA 21 Series
    const ema21Series = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      priceLineVisible: false,
      title: "EMA 21",
    });
    ema21SeriesRef.current = ema21Series;

    // VWAP Series
    const vwapSeries = chart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      title: "VWAP",
    });
    vwapSeriesRef.current = vwapSeries;

    // Crosshair move listener
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setLegendData(null);
        return;
      }
      const candlePoint = param.seriesData.get(candleSeries) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      const volPoint = param.seriesData.get(volumeSeries) as { value: number } | undefined;

      if (candlePoint) {
        const change = candlePoint.close - candlePoint.open;
        const changePct = candlePoint.open ? (change / candlePoint.open) * 100 : 0;
        const d = new Date((param.time as number) * 1000);
        const timeStr = `${d.toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        })} ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;

        setLegendData({
          time: timeStr,
          open: candlePoint.open,
          high: candlePoint.high,
          low: candlePoint.low,
          close: candlePoint.close,
          volume: volPoint?.value,
          change,
          changePct,
        });
      }
    });

    // Resize handler
    const handleResize = () => {
      if (container && chartRef.current) {
        chartRef.current.applyOptions({ width: container.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [symbol, height, showRsi]);

  // 2. Data Update Effect — Updates data in-place without destroying the canvas!
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries || preparedData.candleData.length === 0) return;

    candleSeries.setData(preparedData.candleData);

    if (showVolume && volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(preparedData.volData);
    }

    // Indicators data
    const closes = candles.map((c) => c.c);
    const times = candles.map((c) => Math.floor(c.t / 1000) as UTCTimestamp);

    if (showEma9 && ema9SeriesRef.current) {
      const ema9Vals = calcEma(closes, 9);
      const ema9Data: { time: UTCTimestamp; value: number }[] = [];
      let prevT = 0;
      for (let i = 0; i < ema9Vals.length; i++) {
        const val = ema9Vals[i];
        const t = times[i];
        if (val != null && t > prevT) {
          ema9Data.push({ time: t, value: val });
          prevT = t;
        }
      }
      ema9SeriesRef.current.setData(ema9Data);
    } else if (ema9SeriesRef.current) {
      ema9SeriesRef.current.setData([]);
    }

    if (showEma21 && ema21SeriesRef.current) {
      const ema21Vals = calcEma(closes, 21);
      const ema21Data: { time: UTCTimestamp; value: number }[] = [];
      let prevT = 0;
      for (let i = 0; i < ema21Vals.length; i++) {
        const val = ema21Vals[i];
        const t = times[i];
        if (val != null && t > prevT) {
          ema21Data.push({ time: t, value: val });
          prevT = t;
        }
      }
      ema21SeriesRef.current.setData(ema21Data);
    } else if (ema21SeriesRef.current) {
      ema21SeriesRef.current.setData([]);
    }

    if (showVwap && vwapSeriesRef.current) {
      const vwapVals = calcVwap(candles);
      const vwapData: { time: UTCTimestamp; value: number }[] = [];
      let prevT = 0;
      for (let i = 0; i < vwapVals.length; i++) {
        const val = vwapVals[i];
        const t = times[i];
        if (val != null && t > prevT) {
          vwapData.push({ time: t, value: val });
          prevT = t;
        }
      }
      vwapSeriesRef.current.setData(vwapData);
    } else if (vwapSeriesRef.current) {
      vwapSeriesRef.current.setData([]);
    }

    // Custom Pine-style indicators
    if (chartRef.current) {
      customSeriesRef.current.forEach((ser) => {
        try { chartRef.current?.removeSeries(ser); } catch {}
      });
      customSeriesRef.current = [];
      for (const ind of customPineIndicators.filter((x) => x.enabled)) {
        // Support multi-line Pine-style script: each non-empty line = a separate plot
        const lines = ind.formula
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
        const plots = lines.length > 0 ? lines : [ind.formula];
        const multi = plots.length > 1;
        plots.forEach((expr, pi) => {
          const evald = evaluateFormula(candles, expr);
          if (evald.error || !evald.points.length) return;
          const line = chartRef.current!.addSeries(LineSeries, {
            color: ind.color,
            lineWidth: Math.max(1, Math.min(4, ind.lineWidth || 2)) as 1 | 2 | 3 | 4,
            priceLineVisible: false,
            lineStyle: multi ? (pi % 2 === 0 ? LineStyle.Solid : LineStyle.Dashed) : LineStyle.Solid,
            title: multi ? `${ind.name} ${pi + 1}` : ind.name,
          });
          line.setData(evald.points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.value })));
          customSeriesRef.current.push(line);
        });
      }
    }

    // Scroll to right on initial symbol load only
    if (isFirstLoadRef.current && chartRef.current) {
      chartRef.current.timeScale().scrollToRealTime();
      isFirstLoadRef.current = false;
    }
  }, [preparedData, candles, showVolume, showEma9, showEma21, showVwap, customPineIndicators]);

  // 3. Separate RSI sub-chart when enabled
  useEffect(() => {
    const container = rsiContainerRef.current;
    if (!showRsi || !container) {
      if (rsiChartRef.current) {
        rsiChartRef.current.remove();
        rsiChartRef.current = null;
      }
      return;
    }

    const rsiChart = createChart(container, {
      width: container.clientWidth || 800,
      height: 110,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0f17" },
        textColor: "#94a3b8",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(30, 41, 59, 0.4)" },
        horzLines: { color: "rgba(30, 41, 59, 0.4)" },
      },
      rightPriceScale: {
        borderColor: "#1f2937",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: "#1f2937",
        visible: false,
      },
    });

    rsiChartRef.current = rsiChart;

    const rsiSeries = rsiChart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      priceLineVisible: false,
      title: "RSI 14",
    });
    rsiSeriesRef.current = rsiSeries;

    // Overbought / Oversold guides
    rsiSeries.createPriceLine({
      price: 70,
      color: "#ef4444",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "70",
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: "#22c55e",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "30",
    });

    // Set RSI Data
    if (candles.length > 14) {
      const closes = candles.map((c) => c.c);
      const rsiVals = calcRsi(closes, 14);
      const rsiData: { time: UTCTimestamp; value: number }[] = [];
      let prevT = 0;
      for (let i = 0; i < rsiVals.length; i++) {
        const val = rsiVals[i];
        const sec = Math.floor(candles[i].t / 1000) as UTCTimestamp;
        if (val != null && sec > prevT) {
          rsiData.push({ time: sec, value: val });
          prevT = sec;
        }
      }
      rsiSeries.setData(rsiData);
    }

    return () => {
      if (rsiChartRef.current) {
        rsiChartRef.current.remove();
        rsiChartRef.current = null;
      }
    };
  }, [showRsi, candles]);

  // 4. Price Lines for SL, Target, Support, Resistance, Trailing SL
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    // Clear previous lines
    priceLinesRef.current.forEach((line) => {
      try {
        candleSeries.removePriceLine(line);
      } catch {
        // ignore
      }
    });
    priceLinesRef.current = [];

    if (!showLevels || !levels) return;

    if (levels.stopLoss && levels.stopLoss > 0) {
      const line = candleSeries.createPriceLine({
        price: levels.stopLoss,
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "SL",
      });
      priceLinesRef.current.push(line);
    }

    if (levels.target && levels.target > 0) {
      const line = candleSeries.createPriceLine({
        price: levels.target,
        color: "#22c55e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "TARGET",
      });
      priceLinesRef.current.push(line);
    }

    if (levels.entry && levels.entry > 0) {
      const entryTitle = levels.tradeSide
        ? `${levels.tradeSide} (${levels.tradeQty ?? ""})`
        : "ENTRY";
      const line = candleSeries.createPriceLine({
        price: levels.entry,
        color: "#38bdf8",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: entryTitle,
      });
      priceLinesRef.current.push(line);
    }

    if (levels.trailingSl && levels.trailingSl > 0) {
      const line = candleSeries.createPriceLine({
        price: levels.trailingSl,
        color: "#f59e0b",
        lineWidth: 2,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "TRAIL SL",
      });
      priceLinesRef.current.push(line);
    }

    if (levels.support && levels.support > 0) {
      const line = candleSeries.createPriceLine({
        price: levels.support,
        color: "#64748b",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "SUPPORT",
      });
      priceLinesRef.current.push(line);
    }

    if (levels.resistance && levels.resistance > 0) {
      const line = candleSeries.createPriceLine({
        price: levels.resistance,
        color: "#64748b",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "RESIST",
      });
      priceLinesRef.current.push(line);
    }
  }, [levels, showLevels]);

  // 5. Smooth 0-delay real-time tick update to running candle
  useEffect(() => {
    if (!livePrice || livePrice <= 0 || !candleSeriesRef.current || !preparedData.lastTime) return;

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return;

    try {
      candleSeriesRef.current.update({
        time: preparedData.lastTime as UTCTimestamp,
        open: lastCandle.o,
        high: Math.max(lastCandle.h, livePrice),
        low: Math.min(lastCandle.l, livePrice),
        close: livePrice,
      });
    } catch {
      // ignore
    }
  }, [livePrice, preparedData.lastTime, candles]);

  // Zoom / View buttons
  const fitContent = () => {
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  };

  const centerRunningCandle = () => {
    if (chartRef.current) {
      chartRef.current.timeScale().applyOptions({
        rightOffset: 25,
      });
      chartRef.current.timeScale().scrollToRealTime();
    }
  };

  const currentPrice = livePrice || (candles.length ? candles[candles.length - 1].c : 0);

  return (
    <div className="w-full flex flex-col relative select-none">
      {/* Top Toolbar: Indicator checkboxes, overlays & view adjustments */}
      {showIndicators && (
        <div className="flex flex-wrap items-center justify-between gap-1.5 px-3 py-1.5 bg-[#0e1624] border-b border-[#1f2937] text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] text-slate-400 uppercase font-semibold">Overlays:</span>
            <label className="flex items-center gap-1 cursor-pointer text-slate-300 hover:text-white">
              <input
                type="checkbox"
                checked={showEma9}
                onChange={(e) => setShowEma9(e.target.checked)}
                className="accent-sky-400 rounded cursor-pointer"
              />
              <span className="text-sky-400 font-bold">EMA 9</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-slate-300 hover:text-white">
              <input
                type="checkbox"
                checked={showEma21}
                onChange={(e) => setShowEma21(e.target.checked)}
                className="accent-amber-400 rounded cursor-pointer"
              />
              <span className="text-amber-400 font-bold">EMA 21</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-slate-300 hover:text-white">
              <input
                type="checkbox"
                checked={showVwap}
                onChange={(e) => setShowVwap(e.target.checked)}
                className="accent-purple-400 rounded cursor-pointer"
              />
              <span className="text-purple-400 font-bold">VWAP</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-slate-300 hover:text-white">
              <input
                type="checkbox"
                checked={showVolume}
                onChange={(e) => setShowVolume(e.target.checked)}
                className="accent-emerald-400 rounded cursor-pointer"
              />
              <span className="text-slate-300 font-bold">Volume</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-slate-300 hover:text-white">
              <input
                type="checkbox"
                checked={showRsi}
                onChange={(e) => setShowRsi(e.target.checked)}
                className="accent-purple-400 rounded cursor-pointer"
              />
              <span className="text-violet-300 font-bold">RSI (14)</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-slate-300 hover:text-white">
              <input
                type="checkbox"
                checked={showLevels}
                onChange={(e) => setShowLevels(e.target.checked)}
                className="accent-sky-400 rounded cursor-pointer"
              />
              <span className="text-slate-300 font-bold">SL/TGT Lines</span>
            </label>
          </div>

          <div className="flex items-center gap-1.5 ml-auto">
            <button
              className="btn btn-xs py-0.5 px-2 bg-[#172338] hover:bg-[#20314d] text-sky-300 border-sky-500/30"
              onClick={centerRunningCandle}
              title="Keep running candle centered with space on right"
            >
              ⊙ Center Live
            </button>
            <button
              className="btn btn-xs py-0.5 px-2 bg-[#172338] hover:bg-[#20314d] text-slate-300 border-[#263244]"
              onClick={fitContent}
              title="Fit all candles on screen"
            >
              ⤢ Fit
            </button>
          </div>
        </div>
      )}

      {/* Live Readout Legend (TradingView style on hover or current) */}
      <div className="px-3 py-1 bg-[#0b0f17] text-[11px] mono border-b border-[#16202e] flex flex-wrap items-center gap-x-3 text-slate-400">
        <span className="font-bold text-white">
          {symbol} · {currency}
          {currentPrice.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </span>
        {legendData ? (
          <>
            <span>{legendData.time}</span>
            <span>
              O: <b className="text-slate-200">{legendData.open?.toFixed(2)}</b>
            </span>
            <span>
              H: <b className="text-emerald-400">{legendData.high?.toFixed(2)}</b>
            </span>
            <span>
              L: <b className="text-red-400">{legendData.low?.toFixed(2)}</b>
            </span>
            <span>
              C:{" "}
              <b className={legendData.change && legendData.change >= 0 ? "text-emerald-400" : "text-red-400"}>
                {legendData.close?.toFixed(2)}
              </b>
            </span>
            {legendData.volume != null && (
              <span>
                Vol: <b className="text-slate-200">{legendData.volume.toLocaleString("en-IN")}</b>
              </span>
            )}
            {legendData.changePct != null && (
              <span
                className={`font-semibold ${
                  legendData.changePct >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {legendData.changePct >= 0 ? "+" : ""}
                {legendData.changePct.toFixed(2)}%
              </span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-slate-500">
            Hover over chart for OHLC inspection · Drag to scroll · Wheel to zoom
          </span>
        )}
      </div>

      {/* Main Lightweight Canvas Container */}
      <div className="relative w-full overflow-hidden bg-[#0b0f17]">
        <div ref={containerRef} className="w-full" />
      </div>

      {/* RSI Sub-pane Container (when active) */}
      {showRsi && (
        <div className="w-full border-t border-[#1f2937] bg-[#0b0f17] relative">
          <div className="text-[9px] mono text-slate-400 absolute top-1 left-3 z-10 font-bold">
            RSI 14 (Overbought 70 / Oversold 30)
          </div>
          <div ref={rsiContainerRef} className="w-full h-[110px]" />
        </div>
      )}
    </div>
  );
}

export const TradingViewCanvasChart = memo(TradingViewCanvasChartComponent);
