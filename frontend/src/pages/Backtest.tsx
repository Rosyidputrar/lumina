import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { useTerminal } from '../lib/queries';
import { date, dateTime, fixed, money, num, pct, price, signed, tone, words } from '../lib/format';
import { useTheme } from '../lib/theme';
import type { BacktestResult } from '../lib/types';
import { Button, Card, Empty, Field, Notice, Segmented, SideBadge, Skeleton, Stat, fieldProps } from '../components/ui';

const AreaChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.AreaChart })));

export function Backtest() {
  const terminal = useTerminal();
  const [theme] = useTheme();
  const watch = terminal.data?.watchlist ?? [];
  const [symbol, setSymbol] = useState('');
  const [tf, setTf] = useState('4h');
  const [bars, setBars] = useState('1000');
  const [equity, setEquity] = useState('');
  const [strategy, setStrategy] = useState<'breakout' | 'trend' | 'classic'>('breakout');
  const [errors, setErrors] = useState<{ bars?: string; equity?: string }>({});
  const chosen = watch.find((w) => w.symbol === (symbol || watch[0]?.symbol));
  const run = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<BacktestResult>('/api/backtest', body) });
  const r = run.data;
  const ccy = terminal.data?.account.currency ?? 'USD';

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    const b = Number(bars);
    if (!(b >= 200 && b <= 1000)) next.bars = 'Choose between 200 and 1,000 bars.';
    if (equity && !(Number(equity) > 0)) next.equity = 'Write the starting equity as a positive amount, or leave it empty.';
    setErrors(next);
    if (next.bars || next.equity || !chosen) return;
    run.mutate({ venue: chosen.venue, symbol: chosen.symbol, tf, bars: b, equity: equity ? Number(equity) : undefined, strategy });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Backtest</h2>
          <p>Replays the live playbooks, risk gate and stop management over real venue candles, with this market's trading costs. Each run costs five credits.</p>
        </div>
      </div>
      <div className="grid grid-main">
        <div className="stack" style={{ gap: 'var(--s-5)' }}>
          {run.isPending ? (
            <div className="card" style={{ padding: 'var(--s-5)' }}>
              <Skeleton h={260} />
            </div>
          ) : run.isError ? (
            <Notice kind="error" title="The backtest did not run">{errorText(run.error)}</Notice>
          ) : r && !r.ok ? (
            <Notice kind="warn" title="Not enough history">{words(r.reason)}: the venue returned too few candles for this timeframe.</Notice>
          ) : r ? (
            <>
              <section className="card" aria-label="Backtest results">
                <div className="stat-strip">
                  <Stat label="Return" value={<span className={tone(r.returnPct)}>{pct(r.returnPct, 2, { sign: true })}</span>} sub={`${money(r.startingEquity, null)} → ${money(r.endingEquity, ccy)}`} />
                  <Stat label="Trades" value={num(r.trades, 0)} sub={`${pct(r.winRate, 1)} won · ${r.blocked} blocked by risk`} />
                  <Stat label="Expectancy" value={<span className={tone(r.expectancyR)}>{signed(r.expectancyR, 3)}R</span>} sub={`Before costs ${signed(r.grossR ?? null, 3)}R · PF ${r.profitFactor === null ? '∞' : fixed(r.profitFactor)}`} />
                  <Stat label="Max drawdown" value={<span className="down">{pct(r.maxDrawdownPct)}</span>} sub={`Held ${fixed(r.avgBarsHeld, 1)} bars on average`} />
                </div>
              </section>
              <Card title="Equity through the test" meta={`${r.symbol} · ${r.timeframe} · ${date(r.from)} to ${date(r.to)} · ${r.bars} bars`}>
                <Suspense fallback={<Skeleton h={240} />}>
                  <AreaChart points={r.curve.map((p) => ({ ts: p.ts, value: p.equity }))} height={240} theme={theme} label={`Backtest equity from ${money(r.startingEquity, ccy)} to ${money(r.endingEquity, ccy)}`} />
                </Suspense>
              </Card>
              <Card title="By playbook" bodyClass="flush">
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Playbook</th>
                        <th scope="col" className="r">Trades</th>
                        <th scope="col" className="r">Win rate</th>
                        <th scope="col" className="r">Average R</th>
                        <th scope="col" className="r">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.byPlaybook.map((p) => (
                        <tr key={p.playbook}>
                          <td>{words(p.playbook)}</td>
                          <td className="r num">{p.trades}</td>
                          <td className="r num">{pct(p.winRate, 1)}</td>
                          <td className={`r num ${tone(p.avgR)}`}>{signed(p.avgR, 3)}</td>
                          <td className={`r num ${tone(p.pnl)}`}>{signed(p.pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="Last trades" meta={`The most recent ${r.tradeLog.length} of ${r.trades}`} bodyClass="flush">
                <div className="table-wrap scroll-y">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Exit</th>
                        <th scope="col">Side</th>
                        <th scope="col" className="r">Entry → exit</th>
                        <th scope="col" className="hide-sm">Reason</th>
                        <th scope="col" className="r">R</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...r.tradeLog].reverse().map((t, i) => (
                        <tr key={i}>
                          <td className="num small">{dateTime(t.exitTs ?? null)}</td>
                          <td><SideBadge side={t.side} /></td>
                          <td className="r num">{price(t.entry)} → {price(t.exit)}</td>
                          <td className="hide-sm small muted">{words(t.reason)} · {words(t.playbook)}</td>
                          <td className={`r num ${tone(t.rMultiple)}`}>{signed(t.rMultiple)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="Assumptions">
                <ul className="stack-sm small" style={{ margin: 0, paddingLeft: '1.1em', color: 'var(--ink-2)' }}>
                  {r.assumptions.map((a) => <li key={a}>{a}</li>)}
                </ul>
              </Card>
            </>
          ) : (
            <Card>
              <Empty icon={FlaskConical} title="Choose a market and run a test">Past results do not promise future ones, but a playbook that loses on history deserves suspicion.</Empty>
            </Card>
          )}
        </div>
        <Card title="Test settings" className="first-when-stacked">
          <form className="form-grid" onSubmit={submit} noValidate>
            <Field label="Market" htmlFor="bt-symbol">
              <select id="bt-symbol" className="select" value={chosen?.symbol ?? ''} onChange={(e) => setSymbol(e.target.value)}>
                {watch.map((w) => (
                  <option key={w.symbol} value={w.symbol}>
                    {w.label ?? w.symbol} ({w.venue})
                  </option>
                ))}
              </select>
            </Field>
            <div className="field">
              <span className="field-label">Timeframe</span>
              <Segmented label="Timeframe" className="block" value={tf} onChange={setTf} options={['15m', '1h', '4h', '1d'].map((x) => ({ value: x, label: x }))} />
            </div>
            <div className="field">
              <span className="field-label">Strategy</span>
              <Segmented label="Strategy" className="block" value={strategy} onChange={setStrategy} options={[{ value: 'breakout', label: 'Breakout' }, { value: 'trend', label: 'Trend' }, { value: 'classic', label: 'Classic' }]} />
              <span className="field-hint">
                {strategy === 'breakout'
                  ? 'Donchian 55/20 trend following, crypto only, for 4h and daily bars. Tested profitable on unseen crypto data, with deep drawdowns.'
                  : strategy === 'trend'
                    ? 'With the 200-EMA trend only, stops of 2× ATR or more, skips setups that costs would eat. About break-even on unseen data.'
                    : 'All five playbooks, no trend or cost filter: the original rule set. Lost on unseen data.'}
              </span>
            </div>
            <Field label="Bars" htmlFor="bt-bars" error={errors.bars} hint="Up to 1,000. Some venues return fewer.">
              <input className="input num" inputMode="numeric" {...fieldProps('bt-bars', errors.bars, true)} value={bars} onChange={(e) => setBars(e.target.value)} />
            </Field>
            <Field label={`Starting equity (${ccy})`} htmlFor="bt-eq" error={errors.equity} hint="Empty uses your account's starting equity.">
              <input className="input num" inputMode="decimal" {...fieldProps('bt-eq', errors.equity, true)} value={equity} onChange={(e) => setEquity(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" block go busy={run.isPending} disabled={!chosen}>
              Run backtest
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
