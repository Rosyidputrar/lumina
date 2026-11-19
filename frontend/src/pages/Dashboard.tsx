import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LineChart, Play, Radar, Square, Wallet, Zap } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { keys, useNow, useTerminal } from '../lib/queries';
import { ago, fixed, money, num, pct, signed, time, tone } from '../lib/format';
import { useTheme } from '../lib/theme';
import { useSession } from '../auth/session';
import { Badge, Button, Card, Empty, ErrorState, LoadingRows, Notice, Skeleton, Stat, Switch } from '../components/ui';
import { PositionsTable, QuoteTable, SignalRow } from '../components/trading';
import { useToast } from '../components/Toast';
import type { Terminal } from '../lib/types';

const AreaChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.AreaChart })));

export function Dashboard() {
  const terminal = useTerminal();
  const [theme] = useTheme();
  useNow(15_000);

  if (terminal.isLoading) return <DashboardSkeleton />;
  if (terminal.isError) return <ErrorState error={terminal.error} onRetry={() => terminal.refetch()} title="The terminal could not be loaded" />;
  const t = terminal.data!;
  const ccy = t.account.currency ?? 'USD';
  const signals = [...t.signals].sort((a, b) => b.created_at - a.created_at).slice(0, 5);
  const curve = t.equityCurve.map((p) => ({ ts: p.ts, value: p.equity }));
  const venuesDown = Object.entries(t.marketHealth.venues ?? {}).filter(([, v]) => !v.ok);

  return (
    <>
      {venuesDown.length ? (
        <Notice kind="warn" title="Some market data is unavailable">
          {venuesDown.map(([name, v]) => `${name.toUpperCase()}: ${v.message}`).join(' · ')}. Prices from these venues may be stale.
        </Notice>
      ) : null}
      {t.quotes.length === 0 ? (
        <Notice kind="warn" title="No prices yet">
          The engine has not received a quote for any instrument in the watchlist. If this persists, the venues may be unreachable from the server.
        </Notice>
      ) : null}

      <section className="card" aria-label="Account summary">
        <div className="stat-strip">
          <Stat label="Equity" value={money(t.account.equity, null)} sub={`${ccy} · started at ${num(t.account.startingEquity)}`} />
          <Stat label="Open P&L" value={<span className={tone(t.account.unrealised)}>{signed(t.account.unrealised)}</span>} sub={`${t.positions.length} open position${t.positions.length === 1 ? '' : 's'}`} />
          <Stat label="Today" value={<span className={tone(t.account.dayPnl)}>{signed(t.account.dayPnl)}</span>} sub={`${t.account.dayTrades} order${t.account.dayTrades === 1 ? '' : 's'} today · ${pct(t.risk.dayPnlPct, 2, { sign: true })}`} />
          <Stat label="Realised" value={<span className={tone(t.account.realizedPnl)}>{signed(t.account.realizedPnl)}</span>} sub={`Fees paid ${fixed(t.account.feesPaid)}`} />
        </div>
      </section>

      <div className="grid grid-main">
        <div className="stack" style={{ gap: 'var(--s-5)' }}>
          <Card title="Equity" meta={curve.length > 1 ? `${curve.length} snapshots, one per engine cycle` : undefined}>
            {curve.length > 1 ? (
              <Suspense fallback={<Skeleton h={220} />}>
                <AreaChart points={curve} theme={theme} label={`Equity curve from ${money(curve[0].value, ccy)} to ${money(curve.at(-1)!.value, ccy)}`} />
              </Suspense>
            ) : (
              <Empty icon={LineChart} title="The curve starts with the first engine cycles">
                Each cycle records one equity snapshot. Come back after a few cycles, or run one now from Signals.
              </Empty>
            )}
          </Card>

          <Card
            title="Open positions"
            meta={t.positions.length ? `Open risk ${money(t.risk.openRisk, ccy)} · ${pct(t.risk.openRiskPct)} of equity` : undefined}
            actions={
              <Link className="btn btn--ghost btn--sm" to="/positions">
                All positions
              </Link>
            }
            bodyClass="flush"
          >
            <PositionsTable
              positions={t.positions.slice(0, 6)}
              currency={ccy}
              empty={
                <Empty icon={Wallet} title="No open positions" action={<Link className="btn btn--primary btn--go" to="/markets">Open a trade</Link>}>
                  Place a ticket from Markets, or execute a signal. Every order is sized from its stop.
                </Empty>
              }
            />
          </Card>

          <Card
            title="Latest signals"
            meta={`The engine records a signal at ${t.live.minConfidence - 6}% confidence or more; it trades from ${t.live.minConfidence}%.`}
            actions={
              <Link className="btn btn--ghost btn--sm" to="/signals">
                Scanner
              </Link>
            }
            bodyClass="flush"
          >
            {signals.length ? (
              <ul className="list">
                {signals.map((s) => (
                  <SignalRow key={s.id} signal={s} currency={ccy} />
                ))}
              </ul>
            ) : (
              <Empty icon={Radar} title="No signals yet">
                Signals appear when a playbook fires with enough confidence. The scanner shows why each market has no setup.
              </Empty>
            )}
          </Card>
        </div>

        <div className="stack" style={{ gap: 'var(--s-5)' }}>
          <Card
            title="Watchlist"
            meta={`${t.quotes.length} of ${t.watchlist.length} quoted`}
            actions={
              <Link className="btn btn--ghost btn--sm" to="/markets">
                Charts
              </Link>
            }
            bodyClass="flush"
          >
            {t.quotes.length ? <QuoteTable quotes={t.quotes} compact /> : <LoadingRows rows={4} label="Waiting for quotes" />}
          </Card>
          <EngineCard t={t} />
          <RiskCard t={t} ccy={ccy} />
        </div>
      </div>
    </>
  );
}

function EngineCard({ t }: { t: Terminal }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const auto = useMutation({
    mutationFn: (autoTrade: boolean) => api.post<{ autoTrade: boolean }>('/api/engine/settings', { autoTrade }),
    onSuccess: (r) => {
      qc.setQueryData<Terminal>(keys.terminal, (old) => (old ? { ...old, autoTrade: r.autoTrade } : old));
      toast.success(r.autoTrade ? 'Auto-trade is on' : 'Auto-trade is off', r.autoTrade ? 'The engine may open positions that pass the risk gate.' : 'Signals are still recorded; nothing opens by itself.');
    },
    onError: (e) => toast.error('Auto-trade was not changed', errorText(e)),
  });
  const power = useMutation({
    mutationFn: (start: boolean) => api.post(start ? '/api/engine/start' : '/api/engine/stop'),
    onSuccess: (_r, start) => {
      qc.invalidateQueries({ queryKey: keys.terminal });
      toast.success(start ? 'Engine started' : 'Engine stopped');
    },
    onError: (e) => toast.error('The engine did not respond', errorText(e)),
  });
  const e = t.engine;
  return (
    <Card
      title="Engine"
      meta={`${e.timeframe} bars · every ${Math.round(e.intervalMs / 1000)} s · ${t.analyst.provider}`}
      actions={<Badge tone={e.running ? 'up' : ''} dot>{e.running ? 'Running' : 'Stopped'}</Badge>}
    >
      <div className="stack">
        <dl className="kv">
          <dt>Last cycle</dt>
          <dd>{e.lastRun ? `${ago(e.lastRun)} · ${e.cycleMs ?? 0} ms` : 'not yet'}</dd>
          <dt>Cycles</dt>
          <dd>{num(e.cycle, 0)}</dd>
          <dt>Execution</dt>
          <dd>{t.live.mode === 'live' ? `Live · ${t.live.broker}` : 'Paper'}</dd>
        </dl>
        {e.lastError ? <Notice kind="warn" title="Last error">{e.lastError}</Notice> : null}
        <Switch checked={t.autoTrade} disabled={auto.isPending} onChange={(v) => auto.mutate(v)} label="Auto-trade signals that pass the risk gate" />
        {session.owner ? (
          <Button size="sm" onClick={() => power.mutate(!e.running)} busy={power.isPending}>
            {e.running ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
            {e.running ? 'Stop the engine' : 'Start the engine'}
          </Button>
        ) : null}
        {e.activity.length ? (
          <div className="stack-sm scroll-y" style={{ maxHeight: 220 }} aria-label="Engine activity">
            {e.activity.slice(0, 12).map((a, i) => (
              <div key={`${a.ts}-${i}`} className="activity">
                <time dateTime={new Date(a.ts).toISOString()}>{time(a.ts)}</time>
                <span className={a.level === 'error' ? 'down' : a.level === 'trade' ? '' : 'muted'}>
                  {a.level === 'trade' ? <Zap aria-hidden="true" style={{ display: 'inline', width: 13, height: 13, marginRight: 4, color: 'var(--action)', verticalAlign: '-2px' }} /> : null}
                  {readable(a.message)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Engine messages name playbooks by id (breakout_retest); show them as words. */
function readable(message: string): string {
  return message.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (m) => m.replace(/_/g, ' '));
}

function RiskCard({ t, ccy }: { t: Terminal; ccy: string }) {
  const r = t.risk;
  const l = r.limits;
  const cap = (v: number, unit = '') => (v > 0 ? `${num(v)}${unit}` : 'no cap');
  return (
    <Card title="Risk envelope" meta="Set by the owner. Zero means no cap.">
      <div className="stack">
        <div className="stack-sm">
          <div className="row-between small">
            <span className="muted">Open risk</span>
            <span className="num">
              {money(r.openRisk, ccy)} · {pct(r.openRiskPct)}
            </span>
          </div>
          <div className="meter" role="meter" aria-label="Open risk as a share of equity" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, r.openRiskPct)}>
            <span style={{ width: `${Math.min(100, (r.openRiskPct / Math.max(l.maxPortfolioHeatPct || 5, 0.01)) * 100)}%` }} />
          </div>
        </div>
        <dl className="kv">
          <dt>Risk per trade</dt>
          <dd>{pct(l.maxRiskPerTradePct)}</dd>
          <dt>Leverage used</dt>
          <dd>{fixed(r.leverageUsed)}×</dd>
          <dt>Drawdown</dt>
          <dd className={tone(r.drawdownPct)}>{pct(r.drawdownPct, 2, { sign: true })}</dd>
          <dt>Min confidence</dt>
          <dd>{num(l.minConfidence)}%</dd>
          <dt>Min reward/risk</dt>
          <dd>{fixed(l.minRewardRisk)}R</dd>
          <dt>Daily loss stop</dt>
          <dd>{cap(l.maxDailyLossPct, '%')}</dd>
          <dt>Open positions</dt>
          <dd>{cap(l.maxOpenPositions)}</dd>
          <dt>Per market</dt>
          <dd>{cap(l.maxEntriesPerSymbol)}</dd>
        </dl>
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading the terminal">
      <div className="card" style={{ padding: 'var(--s-5)' }}>
        <div className="grid grid-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="stack-sm">
              <Skeleton h={12} w="40%" />
              <Skeleton h={26} w="70%" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-main">
        <div className="card" style={{ padding: 'var(--s-5)' }}>
          <Skeleton h={260} />
        </div>
        <div className="card">
          <LoadingRows rows={6} />
        </div>
      </div>
    </div>
  );
}
