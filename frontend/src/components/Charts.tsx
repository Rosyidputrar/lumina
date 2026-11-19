/**
 * Price and equity charts on lightweight-charts (canvas, ~45 kB gz), loaded
 * lazily so screens without a chart never pay for it.
 */
import { useEffect, useRef } from 'react';
import { ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../lib/types';
import { cssVar } from '../lib/theme';
import { priceDecimals } from '../lib/format';

/** Charts render in UTC; shifting by the local offset shows the trader's clock. */
const local = (ts: number) => ((ts - new Date(ts).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp;

function baseOptions() {
  const ink = cssVar('--muted') || '#5d6b72';
  const line = cssVar('--line') || 'rgba(31,48,56,.13)';
  return {
    autoSize: true,
    // The TradingView attribution required by the licence is shown in Settings › About.
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: ink, fontFamily: cssVar('--font-mono') || 'monospace', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: line }, horzLines: { color: line } },
    rightPriceScale: { borderColor: line },
    timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
    crosshair: { mode: CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: false },
  };
}

export interface Overlay {
  label: string;
  values: (number | null)[];
  color: string;
}

export interface Level {
  price: number;
  label: string;
  kind: 'entry' | 'stop' | 'target';
}

export function CandleChart({ candles, overlays = [], levels = [], height = 420, theme }: { candles: Candle[]; overlays?: Overlay[]; levels?: Level[]; height?: number; theme: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!el.current || !candles.length) return;
    const chart = createChart(el.current, baseOptions());
    chartRef.current = chart;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const decimals = priceDecimals(candles.at(-1)!.close);
    const series = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
      priceFormat: { type: 'price', precision: decimals, minMove: 1 / 10 ** decimals },
    });
    series.setData(candles.map((c) => ({ time: local(c.ts), open: c.open, high: c.high, low: c.low, close: c.close })));

    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    vol.setData(candles.map((c) => ({ time: local(c.ts), value: c.volume ?? 0, color: c.close >= c.open ? `${up}40` : `${down}40` })));

    for (const o of overlays) {
      const s = chart.addLineSeries({ color: o.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const offset = candles.length - o.values.length;
      s.setData(
        o.values
          .map((v, i) => ({ v, c: candles[i + offset] }))
          .filter((x) => x.c && x.v !== null && Number.isFinite(x.v))
          .map((x) => ({ time: local(x.c.ts), value: x.v as number })),
      );
    }

    const colour = { entry: cssVar('--action'), stop: down, target: up };
    for (const l of levels) {
      if (!Number.isFinite(l.price)) continue;
      series.createPriceLine({ price: l.price, color: colour[l.kind], lineWidth: 1, lineStyle: l.kind === 'entry' ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true, title: l.label });
    }
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, overlays, levels, theme]);

  return <div ref={el} className="chart" style={{ height }} role="img" aria-label={`Price chart, ${candles.length} candles${levels.length ? `, with ${levels.map((l) => l.label.toLowerCase()).join(', ')} marked` : ''}`} />;
}

export function AreaChart({ points, height = 220, theme, label }: { points: { ts: number; value: number }[]; height?: number; theme: string; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || points.length < 2) return;
    const chart = createChart(el.current, { ...baseOptions(), crosshair: { mode: CrosshairMode.Magnet } });
    const action = cssVar('--action');
    const s = chart.addAreaSeries({ lineColor: action, topColor: `${action}33`, bottomColor: `${action}00`, lineWidth: 2, priceLineVisible: false });
    // Two points can share a second; the chart needs strictly increasing time.
    const seen = new Set<number>();
    const data = [];
    for (const p of points) {
      const t = local(p.ts);
      if (seen.has(t)) continue;
      seen.add(t);
      data.push({ time: t, value: p.value });
    }
    s.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, theme]);
  return <div ref={el} className="chart" style={{ height }} role="img" aria-label={label} />;
}
