/** Number, money and time formatting. One place, so every screen agrees. */

const nf = (min: number, max: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
const cache = new Map<string, Intl.NumberFormat>();
function fmtWith(min: number, max: number) {
  const k = `${min}:${max}`;
  let f = cache.get(k);
  if (!f) {
    f = nf(min, max);
    cache.set(k, f);
  }
  return f;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Decimals a price needs: 2 for 63,204.20; 5 for 1.12316; 6 for 0.000123. */
export function priceDecimals(v: number): number {
  const a = Math.abs(v);
  if (a >= 1000) return 2;
  if (a >= 10) return 3;
  if (a >= 1) return 5;
  if (a >= 0.01) return 6;
  return 8;
}

export function price(v: number | null | undefined, decimals?: number): string {
  if (!isNum(v)) return '—';
  const d = decimals ?? priceDecimals(v);
  return fmtWith(d, d).format(v);
}

export function num(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return '—';
  return fmtWith(0, decimals).format(v);
}

export function fixed(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return '—';
  return fmtWith(decimals, decimals).format(v);
}

export function money(v: number | null | undefined, currency: string | null = 'USD', { sign = false } = {}): string {
  if (!isNum(v)) return '—';
  const s = sign && v > 0 ? '+' : v < 0 ? '−' : '';
  const body = fmtWith(2, 2).format(Math.abs(v));
  return `${s}${body}${currency ? ` ${currency}` : ''}`;
}

export function signed(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return '—';
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${s}${fmtWith(decimals, decimals).format(Math.abs(v))}`;
}

export function pct(v: number | null | undefined, decimals = 2, { sign = false } = {}): string {
  if (!isNum(v)) return '—';
  const s = sign && v > 0 ? '+' : v < 0 ? '−' : '';
  return `${s}${fmtWith(decimals, decimals).format(Math.abs(v))}%`;
}

export function qty(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 100 ? 2 : a >= 1 ? 4 : 6;
  return fmtWith(0, d).format(v);
}

export function bytes(n: number | null | undefined): string {
  if (!isNum(n)) return '—';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${n} B`;
}

/** The colour class for a profit or loss value. */
export function tone(v: number | null | undefined): '' | 'up' | 'down' {
  if (!isNum(v) || v === 0) return '';
  return v > 0 ? 'up' : 'down';
}

const dtf = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const tf = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function dateTime(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : dtf.format(d);
}

export function date(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : df.format(d);
}

export function time(ts: number | null | undefined): string {
  if (!isNum(ts)) return '—';
  return tf.format(new Date(ts));
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!isNum(ts)) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "trend_pullback" → "Trend pullback"; "closed_at_broker" → "Closed at broker". */
export function words(v: string | null | undefined): string {
  if (!v) return '—';
  const s = String(v).replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
