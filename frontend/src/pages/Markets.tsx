import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CandlestickChart, ShieldAlert } from 'lucide-react';
import { api, ApiError, errorText } from '../lib/api';
import { invalidateBook, keys, useTerminal } from '../lib/queries';
import { fixed, money, num, pct, price, priceDecimals, qty as fmtQty, tone, words } from '../lib/format';
import { useTheme, cssVar } from '../lib/theme';
import type { AnalysisResponse, Explanation, Plan, Quote, Terminal } from '../lib/types';
import { Badge, Button, Card, Empty, ErrorState, Field, LoadingRows, Notice, Segmented, SideBadge, Skeleton, Tabs, fieldProps } from '../components/ui';
import { QuoteTable } from '../components/trading';
import { useToast } from '../components/Toast';
import type { Level, Overlay } from '../components/Charts';

const CandleChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.CandleChart })));

const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'] as const;
type Tf = (typeof TIMEFRAMES)[number];

export function Markets() {
  const terminal = useTerminal();
  const [params, setParams] = useSearchParams();
  const t = terminal.data;
  const quotes = t?.quotes ?? [];
  const symbol = params.get('symbol') ?? quotes[0]?.symbol ?? t?.watchlist[0]?.symbol ?? '';
  const item = t?.watchlist.find((w) => w.symbol === symbol);
  const quote = quotes.find((q) => q.symbol === symbol);
  const prefTf = (t?.preferences.timeframe as Tf) ?? '1h';
  const [tf, setTf] = useState<Tf>(TIMEFRAMES.includes(prefTf) ? prefTf : '1h');

  if (terminal.isLoading) return <LoadingRows rows={8} label="Loading markets" />;
  if (terminal.isError) return <ErrorState error={terminal.error} onRetry={() => terminal.refetch()} />;
  if (!t!.watchlist.length)
    return (
      <Card>
        <Empty icon={CandlestickChart} title="The watchlist is empty">
          The owner chooses the markets this server analyses. Ask them to add instruments in the owner console.
        </Empty>
      </Card>
    );

  const select = (q: Quote) => setParams({ symbol: q.symbol }, { replace: true });

  return (
    <div className="grid grid-main markets-layout">
      <div className="stack markets-main" style={{ gap: 'var(--s-5)' }}>
        {item ? <ChartPanel venue={item.venue} symbol={symbol} label={item.label ?? symbol} quote={quote} tf={tf} setTf={setTf} /> : <Notice kind="warn">That market is not in the watchlist.</Notice>}
      </div>
      <div className="stack markets-side" style={{ gap: 'var(--s-5)' }}>
        {item ? <Ticket terminal={t!} symbol={symbol} quote={quote} venue={item.venue} tf={tf} /> : null}
        <Card className="m-watch" title="Watchlist" bodyClass="flush" meta="Select a market to chart it">
          <QuoteTable quotes={quotes} onSelect={select} selected={symbol} compact />
        </Card>
      </div>
    </div>
  );
}

function ChartPanel({ venue, symbol, label, quote, tf, setTf }: { venue: string; symbol: string; label: string; quote?: Quote; tf: Tf; setTf: (t: Tf) => void }) {
  const [theme] = useTheme();
  const [tab, setTab] = useState<'plan' | 'explain' | 'levels'>('plan');
  const analysis = useQuery({
    queryKey: keys.analysis(venue, symbol, tf),
    queryFn: ({ signal }) => api.get<AnalysisResponse>('/api/analysis', { venue, symbol, tf }, signal),
    refetchInterval: 60_000,
  });
  const explain = useQuery({
    queryKey: keys.explain(venue, symbol, tf),
    queryFn: ({ signal }) => api.get<{ explanation: Explanation }>('/api/ai/explain', { venue, symbol, tf }, signal),
    enabled: tab === 'explain',
    staleTime: 60_000,
  });

  const plan = analysis.data?.plan;
  const overlays = useMemo<Overlay[]>(() => {
    if (!analysis.data) return [];
    const s = analysis.data.series;
    return [
      { label: 'EMA 21', values: s.ema21, color: cssVar('--action') },
      { label: 'EMA 50', values: s.ema50, color: cssVar('--warn') },
      { label: 'VWAP', values: s.vwap, color: cssVar('--muted') },
    ];
  }, [analysis.data, theme]); // the theme changes the colours
  const levels = useMemo<Level[]>(
    () =>
      plan?.ok
        ? [
            { price: plan.entry!, label: 'Entry', kind: 'entry' },
            { price: plan.stop!, label: 'Stop', kind: 'stop' },
            { price: plan.target1!, label: 'Target', kind: 'target' },
          ]
        : [],
    [plan],
  );
  const last = analysis.data?.candles.at(-1);
  const stale = analysis.data?.candles.some((c) => c.stale);

  return (
    <>
      <section className="card m-chart" aria-label={`${label} chart`}>
        <header className="card-head" style={{ flexWrap: 'wrap', rowGap: 'var(--s-2)' }}>
          <div className="stack-sm" style={{ gap: 0 }}>
            <div className="row" style={{ gap: 'var(--s-3)' }}>
              <h2>{label}</h2>
              <span className="num" style={{ fontSize: 18 }}>{price(quote?.price ?? last?.close)}</span>
              {quote ? <span className={`num small ${tone(quote.changePct)}`}>{pct(quote.changePct, 2, { sign: true })}</span> : null}
            </div>
            <span className="meta">
              {symbol} · {venue.toUpperCase()}
              {quote?.bid && quote?.ask ? ` · bid ${price(quote.bid)} · ask ${price(quote.ask)}` : ''}
              {stale ? ' · showing cached candles' : ''}
            </span>
          </div>
          <Segmented label="Timeframe" value={tf} onChange={setTf} options={TIMEFRAMES.map((x) => ({ value: x, label: x }))} />
        </header>
        <div style={{ padding: 'var(--s-3) var(--s-2) var(--s-2)' }}>
          {analysis.isLoading ? (
            <Skeleton h={420} />
          ) : analysis.isError ? (
            <ErrorState error={analysis.error} onRetry={() => analysis.refetch()} title="Candles could not be loaded" />
          ) : analysis.data && analysis.data.candles.length ? (
            <div className="chart" style={{ position: 'relative' }}>
              <div className="chart-legend" aria-hidden="true">
                {overlays.map((o) => (
                  <span key={o.label} style={{ color: o.color }}>
                    <i />
                    {o.label}
                  </span>
                ))}
              </div>
              <Suspense fallback={<Skeleton h={420} />}>
                <CandleChart candles={analysis.data.candles} overlays={overlays} levels={levels} theme={theme} height={420} />
              </Suspense>
            </div>
          ) : (
            <Empty title="No candles for this timeframe" />
          )}
        </div>
      </section>

      <section className="card m-analysis" aria-label="Analysis">
        <div style={{ padding: '0 var(--s-4)' }}>
          <Tabs
            label="Analysis views"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'plan', label: 'Plan' },
              { value: 'explain', label: 'Briefing' },
              { value: 'levels', label: 'Indicators and levels' },
            ]}
          />
        </div>
        <div className="card-body" role="tabpanel">
          {analysis.isLoading ? <LoadingRows rows={4} /> : !plan ? null : tab === 'plan' ? <PlanView plan={plan} /> : tab === 'explain' ? <ExplainView q={explain} /> : <LevelsView plan={plan} />}
        </div>
      </section>
    </>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  if (!plan.ok) {
    return (
      <div className="stack">
        <Notice kind="info" title={plan.reason === 'insufficient_history' ? 'Not enough history yet' : plan.reason === 'filtered_by_strategy' ? 'A setup appeared, but the strategy filtered it' : 'No setup on this timeframe'}>
          {plan.reason === 'insufficient_history'
            ? 'The engine needs at least 60 closed bars before it scores anything.'
            : plan.reason === 'filtered_by_strategy'
              ? `The ${plan.strategy === 'breakout' ? 'breakout' : plan.strategy === 'classic' ? 'classic' : 'trend-aligned'} strategy only takes setups that pass its rules. The tape reads as ${plan.regime?.label.toLowerCase() ?? 'unclear'}.`
              : `No playbook fired with acceptable geometry. The tape reads as ${plan.regime?.label.toLowerCase() ?? 'unclear'}${plan.regime?.adx ? ` (ADX ${fixed(plan.regime.adx, 1)})` : ''}. Standing aside is a position.`}
        </Notice>
        {plan.filtered?.length ? (
          <ul className="stack-sm small" style={{ margin: 0, paddingLeft: '1.1em', color: 'var(--ink-2)' }}>
            {plan.filtered.map((f) => (
              <li key={`${f.playbook}-${f.direction}`}>
                {words(f.playbook)}, {f.direction}: {f.why}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  const risk = Math.abs(plan.entry! - plan.stop!);
  return (
    <div className="stack">
      <div className="row" style={{ gap: 'var(--s-2)' }}>
        <h3>{plan.name}</h3>
        <SideBadge side={plan.direction} />
        {plan.systematic ? <Badge tone="action">Rule signal</Badge> : <Badge tone="action">{fixed(plan.confidence, 1)}% confidence</Badge>}
        {plan.systematic ? <Badge>Exit on the {plan.exit?.bars ?? 20}-bar channel</Badge> : <Badge>{fixed(plan.rewardRisk)}R</Badge>}
        <Badge>{plan.regime?.label}</Badge>
      </div>
      {plan.thesis ? <p className="measure" style={{ color: 'var(--ink-2)' }}>{plan.thesis}</p> : null}
      <div className="grid grid-3" style={{ gap: 'var(--s-3)' }}>
        <div className="card" style={{ padding: 'var(--s-3) var(--s-4)' }}>
          <span className="label">Entry</span>
          <div className="num">{price(plan.entry)}</div>
        </div>
        <div className="card" style={{ padding: 'var(--s-3) var(--s-4)' }}>
          <span className="label">Stop · {pct((risk / plan.entry!) * 100)} away</span>
          <div className="num down">{price(plan.stop)}</div>
        </div>
        <div className="card" style={{ padding: 'var(--s-3) var(--s-4)' }}>
          <span className="label">{plan.systematic ? 'Exit' : 'Targets'}</span>
          {plan.systematic ? (
            <div className="small">No fixed target: it follows the trend until a close crosses the {plan.exit?.bars ?? 20}-bar channel.</div>
          ) : (
            <div className="num up">
              {price(plan.target1)} · {price(plan.target2)}
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-2">
        <div>
          <h4 className="label" style={{ marginBottom: 'var(--s-1)' }}>
            {plan.systematic ? 'The rules' : 'What scored it'}
          </h4>
          {plan.systematic ? (
            <ul className="stack-sm small" style={{ margin: 0, paddingLeft: '1.1em' }}>
              {(plan.factors ?? []).map((f) => (
                <li key={f.label}>
                  <strong style={{ fontWeight: 500 }}>{f.label}:</strong> {f.note}
                </li>
              ))}
            </ul>
          ) : null}
          {(plan.systematic ? [] : plan.factors ?? []).map((f) => (
            <div key={f.label} className="factor">
              <span className="factor-name">{f.label}</span>
              <span className="num small">
                {fixed(f.points, 1)} / {f.weight}
              </span>
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${Math.round((f.points / f.weight) * 100)}%` }} />
              </div>
              <span className="factor-note">{f.note}</span>
            </div>
          ))}
        </div>
        <div className="stack">
          <div>
            <h4 className="label" style={{ marginBottom: 'var(--s-2)' }}>
              What proves it wrong
            </h4>
            <ul style={{ margin: 0, paddingLeft: '1.1em' }} className="stack-sm small">
              {(plan.invalidations ?? []).map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          {plan.alternatives?.length ? (
            <div>
              <h4 className="label" style={{ marginBottom: 'var(--s-2)' }}>
                Also considered
              </h4>
              <ul className="stack-sm small" style={{ margin: 0, paddingLeft: '1.1em' }}>
                {plan.alternatives.map((a) => (
                  <li key={a.playbook}>
                    {a.name}, {a.direction}, {fixed(a.confidence, 1)}%
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The briefing text uses **bold** markers; render them without trusting HTML. */
function Bolded({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? <strong key={i} style={{ fontWeight: 600 }}>{p.slice(2, -2)}</strong> : <span key={i}>{p.replace(/\*([^*]+)\*/g, '$1')}</span>,
      )}
    </>
  );
}

function ExplainView({ q }: { q: UseQueryResult<{ explanation: Explanation }> }) {
  if (q.isLoading) return <LoadingRows rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const ex = q.data!.explanation;
  return (
    <div className="stack">
      <div className="row-between">
        <h3>{ex.headline}</h3>
        <Badge>{ex.provider}</Badge>
      </div>
      <div className="prose stack-sm">
        {ex.body.map((b, i) => (
          <p key={i}>
            <Bolded text={b} />
          </p>
        ))}
      </div>
    </div>
  );
}

function LevelsView({ plan }: { plan: Plan }) {
  const s = plan.snapshot ?? {};
  const rows: [string, string][] = [
    ['RSI 14', fixed(s.rsi, 1)],
    ['ADX', fixed(s.adx, 1)],
    ['ATR', price(s.atr ?? null)],
    ['ATR % of price', pct(s.atrPct ?? null)],
    ['EMA 21', price(s.ema21 ?? null)],
    ['EMA 50', price(s.ema50 ?? null)],
    ['EMA 200', price(s.ema200 ?? null)],
    ['VWAP', price(s.vwap ?? null)],
    ['MACD histogram', fixed(s.macdHist, 4)],
    ['Volume vs average', `${fixed(s.volRatio)}×`],
  ];
  return (
    <div className="grid grid-2">
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h4 className="label" style={{ marginBottom: 'var(--s-2)' }}>
          Tested levels
        </h4>
        {plan.zones?.length ? (
          <dl className="kv">
            {plan.zones.slice(0, 8).map((z) => (
              <div key={`${z.price}-${z.kind}`} style={{ display: 'contents' }}>
                <dt>
                  {words(z.kind)} · {z.touches}× tested
                </dt>
                <dd>
                  {price(z.price)} <span className="muted">({pct(z.distancePct, 2, { sign: true })})</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="small muted">No level has been tested often enough to count.</p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- ticket */

type TicketMode = 'market' | 'pending';

function Ticket({ terminal, symbol, quote, venue, tf }: { terminal: Terminal; symbol: string; quote?: Quote; venue: string; tf: Tf }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<TicketMode>('market');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qtyStr, setQty] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [trigger, setTrigger] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const plan = qc.getQueryData<AnalysisResponse>(keys.analysis(venue, symbol, tf))?.plan;

  useEffect(() => {
    setQty('');
    setStop('');
    setTarget('');
    setTrigger('');
    setErrors({});
    setFormError(null);
  }, [symbol]);

  const ccy = terminal.account.currency ?? 'USD';
  const ref = mode === 'pending' ? Number(trigger) || quote?.price : quote?.price;
  const stopN = Number(stop);
  const riskPct = terminal.risk.limits.maxRiskPerTradePct / 100;
  const maxQty = ref && stopN > 0 && Math.abs(ref - stopN) > 0 ? (terminal.account.equity * riskPct) / Math.abs(ref - stopN) : null;
  const d = ref ? priceDecimals(ref) : 2;

  const send = useMutation({
    mutationFn: async () => {
      if (mode === 'market') {
        return api.post<{ fill: number; live: boolean }>('/api/positions', { symbol, side, qty: Number(qtyStr), stop: stopN, target: target ? Number(target) : null });
      }
      return api.post('/api/pending-orders', { symbol, side, qty: Number(qtyStr), triggerPrice: Number(trigger), stop: stopN || null, target: target ? Number(target) : null });
    },
    onSuccess: (r) => {
      if (mode === 'market') {
        const res = r as { fill: number; live: boolean };
        toast.success(`${side === 'buy' ? 'Bought' : 'Sold'} ${fmtQty(Number(qtyStr))} ${symbol}`, `Filled at ${price(res.fill)} on ${res.live ? 'the live account' : 'paper'}.`);
      } else {
        toast.success('Pending order placed', `${side === 'buy' ? 'Buy' : 'Sell'} ${fmtQty(Number(qtyStr))} ${symbol} when price reaches ${price(Number(trigger))}.`);
      }
      setQty('');
      setFormError(null);
      invalidateBook(qc);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VOLUME_EXCEEDS_RISK') setErrors((x) => ({ ...x, qty: e.message }));
      else if (e instanceof ApiError && (e.code === 'BAD_STOP' || e.code === 'STOP_REQUIRED')) setErrors((x) => ({ ...x, stop: e.message }));
      else if (e instanceof ApiError && e.code === 'BAD_TARGET') setErrors((x) => ({ ...x, target: e.message }));
      else setFormError(errorText(e));
    },
  });

  function applyPlan() {
    if (!plan?.ok) return;
    setSide(plan.direction === 'long' ? 'buy' : 'sell');
    setStop(String(plan.stop));
    setTarget(plan.target1 === null || plan.target1 === undefined ? '' : String(plan.target1));
    if (mode === 'pending') setTrigger(String(plan.entry));
    setErrors({});
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: Record<string, string | undefined> = {};
    const q = Number(qtyStr);
    const tr = Number(trigger);
    const base = mode === 'pending' ? tr : quote?.price;
    if (mode === 'pending' && !(tr > 0)) next.trigger = 'Write the price that should trigger the order.';
    if (!(stopN > 0)) next.stop = mode === 'market' ? 'A stop loss is required: it sizes the order.' : undefined;
    if (stop && !(stopN > 0)) next.stop = 'Write the stop as a positive price.';
    if (base && stopN > 0) {
      if (side === 'buy' && stopN >= base) next.stop = `A buy stop must be below ${mode === 'market' ? 'the market' : 'the trigger'} (${price(base)}).`;
      if (side === 'sell' && stopN <= base) next.stop = `A sell stop must be above ${mode === 'market' ? 'the market' : 'the trigger'} (${price(base)}).`;
    }
    if (target) {
      const tg = Number(target);
      if (!(tg > 0)) next.target = 'Write the target as a positive price.';
      else if (base && side === 'buy' && tg <= base) next.target = `A buy target must be above ${price(base)}.`;
      else if (base && side === 'sell' && tg >= base) next.target = `A sell target must be below ${price(base)}.`;
    }
    if (!(q > 0)) next.qty = 'Write a size greater than zero.';
    else if (mode === 'market' && maxQty && q > maxQty * 1.0000001) next.qty = `The risk gate allows at most ${fmtQty(maxQty)} with this stop.`;
    if (mode === 'market' && !quote) next.form = 'There is no live quote for this market right now.';
    setErrors(next);
    const firstBad = ['trigger', 'qty', 'stop', 'target'].find((k) => next[k]);
    if (firstBad) {
      document.getElementById(`tk-${firstBad}`)?.focus();
      return;
    }
    if (next.form) {
      setFormError(next.form);
      return;
    }
    send.mutate();
  }

  const riskAmount = maxQty && Number(qtyStr) > 0 && ref ? Math.abs(ref - stopN) * Number(qtyStr) : null;

  return (
    <Card className="m-ticket" title="Order ticket" meta={terminal.live.mode === 'live' ? 'Orders go to the live broker account' : 'Paper account · no real money'}>
      <form className="form-grid" onSubmit={submit} noValidate>
        <Segmented label="Order type" className="block" value={mode} onChange={setMode} options={[{ value: 'market', label: 'Market' }, { value: 'pending', label: 'Pending' }]} />
        <Segmented
          label="Side"
          className="block side"
          value={side}
          onChange={setSide}
          options={[
            { value: 'buy', label: 'Buy', side: 'buy' },
            { value: 'sell', label: 'Sell', side: 'sell' },
          ]}
        />
        {plan?.ok ? (
          <button type="button" className="link small" style={{ justifySelf: 'start' }} onClick={applyPlan}>
            Use the {words(plan.playbook)} plan levels ({plan.direction}, stop {price(plan.stop)}{plan.systematic ? ', no fixed target' : ''})
          </button>
        ) : null}
        {mode === 'pending' ? (
          <Field label="Trigger price" htmlFor="tk-trigger" error={errors.trigger} hint={side === 'buy' ? 'Fills when price falls to this level.' : 'Fills when price rises to this level.'}>
            <input className="input num" inputMode="decimal" {...fieldProps('tk-trigger', errors.trigger, true)} value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder={quote ? price(quote.price, d).replace(/,/g, '') : ''} />
          </Field>
        ) : null}
        <div className="form-grid-2">
          <Field label="Stop loss" htmlFor="tk-stop" error={errors.stop}>
            <input className="input num" inputMode="decimal" {...fieldProps('tk-stop', errors.stop)} value={stop} onChange={(e) => setStop(e.target.value)} />
          </Field>
          <Field label="Take profit" htmlFor="tk-target" error={errors.target} hint="Optional">
            <input className="input num" inputMode="decimal" {...fieldProps('tk-target', errors.target, true)} value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
        </div>
        <Field label="Size" htmlFor="tk-qty" error={errors.qty} hint={maxQty ? `Risk-sized maximum ${fmtQty(maxQty)} (${pct(riskPct * 100)} of equity)` : 'Set a stop to see the risk-sized maximum.'}>
          <div className="row" style={{ flexWrap: 'nowrap', gap: 'var(--s-2)' }}>
            <input className="input num" inputMode="decimal" {...fieldProps('tk-qty', errors.qty, true)} value={qtyStr} onChange={(e) => setQty(e.target.value)} />
            <Button size="sm" onClick={() => maxQty && setQty(String(Number((maxQty * 0.999).toPrecision(6))))} disabled={!maxQty} style={{ height: 'var(--ctl-h-lg)' }}>
              Max
            </Button>
          </div>
        </Field>
        <dl className="kv">
          <dt>{mode === 'market' ? 'Market price' : 'Trigger'}</dt>
          <dd>{price(ref ?? null)}</dd>
          <dt>Risk if stopped</dt>
          <dd className={riskAmount ? 'down' : ''}>{riskAmount ? money(-riskAmount, ccy) : '—'}</dd>
          <dt>Notional</dt>
          <dd>{ref && Number(qtyStr) > 0 ? money(ref * Number(qtyStr), ccy) : '—'}</dd>
        </dl>
        {formError ? <Notice kind="error">{formError}</Notice> : null}
        <Button type="submit" variant={side === 'buy' ? 'buy' : 'sell'} size="lg" block busy={send.isPending}>
          {mode === 'market' ? `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}` : `Place pending ${side}`}
        </Button>
        <p className="small muted" style={{ display: 'flex', gap: 6 }}>
          <ShieldAlert aria-hidden="true" style={{ width: 15, height: 15, flex: 'none', marginTop: 3 }} />
          Every order passes the server's risk gate first. Pending orders fill at market once the trigger is touched, checked each engine cycle.
        </p>
        <p className="visually-hidden" aria-live="polite">
          {maxQty ? `Maximum size ${num(maxQty, 6)}` : ''}
        </p>
      </form>
    </Card>
  );
}
