/** A tiny inline trend line. Plain SVG: no chart library for a 40px line. */
export function Sparkline({ values, tone, label }: { values: number[]; tone?: 'up' | 'down' | ''; label?: string }) {
  if (values.length < 2) return <div className="spark" aria-hidden="true" />;
  const w = 120;
  const h = 40;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(' ');
  const colour = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--action)';
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline points={pts} fill="none" stroke={colour} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
