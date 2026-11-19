import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Radar, RefreshCw, Zap } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { invalidateBook, keys, useTerminal } from '../lib/queries';
import { ago, fixed, price, words } from '../lib/format';
import type { SweepResponse } from '../lib/types';
import { Badge, Button, Card, Empty, ErrorState, LoadingRows, Segmented, SideBadge, Switch } from '../components/ui';
import { SignalRow } from '../components/trading';
import { useToast } from '../components/Toast';

const PATTERNS = [
  { value: 'any', label: 'Any playbook' },
  { value: 'trend_pullback', label: 'Trend pullback' },
  { value: 'breakout_retest', label: 'Breakout retest' },
  { value: 'liquidity_sweep_reversal', label: 'Liquidity sweep' },
  { value: 'range_mean_reversion', label: 'Range reversion' },
  { value: 'momentum_continuation', label: 'Momentum' },
];

const REASONS: Record<string, string> = {
  no_setup: 'No playbook fired',
  insufficient_history: 'Not enough history',
};

export function Signals() {
  const terminal = useTerminal();
  const qc = useQueryClient();
  const toast = useToast();
  const [tf, setTf] = useState(terminal.data?.preferences.timeframe ?? '1h');
  const [pattern, setPattern] = useState('any');
  const [profitOnly, setProfitOnly] = useState(true);
  const [minRR, setMinRR] = useState(1.5);
  const sweep = useQuery({
    queryKey: keys.sweep(tf, pattern, profitOnly, minRR),
    queryFn: ({ signal }) => api.get<SweepResponse>('/api/analysis/sweep', { tf, pattern, profitOnly: profitOnly ? 1 : 0, minRR }, signal),
    staleTime: 30_000,
  });
  const cycle = useMutation({
    mutationFn: () => api.post<{ ms: number; results: { opened?: unknown[] | { skipped: string } }[] }>('/api/analysis/run'),
    onSuccess: (r) => {
      const opened = r.results.reduce((a, x) => a + (Array.isArray(x.opened) ? x.opened.length : 0), 0);
      toast.success('Analysis cycle finished', `${r.ms} ms · ${opened ? `${opened} position${opened === 1 ? '' : 's'} opened` : 'nothing opened'} · ${terminal.data?.autoTrade ? 'auto-trade on' : 'auto-trade off'}`);
      invalidateBook(qc);
      qc.invalidateQueries({ queryKey: ['sweep'] });
    },
    onError: (e) => toast.error('The cycle did not run', errorText(e)),
  });
  const ccy = terminal.data?.account.currency ?? 'USD';
  const signals = terminal.data?.recentSignals ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Scanner</h2>
          <p>Every watched market analysed at once. Markets without a setup are listed with the reason, so an empty result is never a mystery.</p>
        </div>
        <div className="page-actions">
          <Button onClick={() => sweep.refetch()} busy={sweep.isFetching && !sweep.isLoading}>
            <RefreshCw aria-hidden="true" /> Rescan
          </Button>
          <Button variant="primary" onClick={() => cycle.mutate()} busy={cycle.isPending} title={`Costs credits from the licence quota`}>
            <Zap aria-hidden="true" /> Run engine cycle
          </Button>
        </div>
      </div>

      <section className="card" aria-label="Scanner filters">
        <div className="card-body tight row" style={{ gap: 'var(--s-4)' }}>
          <Segmented label="Timeframe" value={tf} onChange={setTf} options={['15m', '1h', '4h', '1d'].map((x) => ({ value: x, label: x }))} />
          <label className="field" style={{ minWidth: 200 }}>
            <span className="visually-hidden">Playbook</span>
            <select className="select" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Playbook">
              {PATTERNS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <Switch checked={profitOnly} onChange={setProfitOnly} label="Only setups at or above" />
          <label className="row" style={{ gap: 'var(--s-2)' }}>
            <span className="visually-hidden">Minimum reward to risk</span>
            <input className="input num" style={{ width: 84 }} type="number" min={1} max={10} step={0.1} value={minRR} disabled={!profitOnly} onChange={(e) => setMinRR(Math.max(1, Number(e.target.value) || 1))} />
            <span className="small muted">R</span>
          </label>
        </div>
      </section>

      <div className="grid grid-main">
        <Card title="Setups" meta={sweep.data ? `${sweep.data.setups.length} of ${sweep.data.analysed} markets qualify · scanned ${ago(sweep.data.at)}` : undefined} bodyClass="flush">
          {sweep.isLoading ? (
            <LoadingRows rows={6} label="Scanning markets" />
          ) : sweep.isError ? (
            <ErrorState error={sweep.error} onRetry={() => sweep.refetch()} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Market</th>
                    <th scope="col">Setup</th>
                    <th scope="col" className="r">Confidence</th>
                    <th scope="col" className="r">R</th>
                    <th scope="col" className="r hide-sm">Stop / target</th>
                    <th scope="col"><span className="visually-hidden">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sweep.data!.setups.map((r) => (
                    <tr key={r.symbol}>
                      <td>
                        <div className="sym">
                          <strong>{r.label}</strong>
                          <span>{price(r.price)} · {words(r.regime)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <SideBadge side={r.direction} />
                          <span className="small">{words(r.playbook)}</span>
                        </div>
                      </td>
                      <td className="r num">{fixed(r.confidence, 1)}%</td>
                      <td className="r num">{fixed(r.rewardRisk)}</td>
                      <td className="r num muted hide-sm">{price(r.stop)} / {price(r.target1)}</td>
                      <td className="r">
                        <Link className="btn btn--sm" to={`/markets?symbol=${encodeURIComponent(r.symbol)}`}>Chart</Link>
                      </td>
                    </tr>
                  ))}
                  {sweep.data!.rejected.map((r) => (
                    <tr key={r.symbol} style={{ color: 'var(--muted)' }}>
                      <td>
                        <div className="sym">
                          <strong style={{ color: 'var(--ink-2)' }}>{r.label ?? r.symbol}</strong>
                          <span>{price(r.price)}{r.regime ? ` · ${words(r.regime)}` : ''}</span>
                        </div>
                      </td>
                      <td colSpan={4} className="small">
                        {r.ok ? `${words(r.playbook)} ${r.direction} at ${fixed(r.rewardRisk)}R: below the filter` : (REASONS[r.reason ?? ''] ?? r.reason ?? 'Rejected')}
                      </td>
                      <td className="r">
                        <Link className="btn btn--ghost btn--sm" to={`/markets?symbol=${encodeURIComponent(r.symbol)}`}>Chart</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!sweep.data!.analysed ? <Empty icon={Radar} title="Nothing to scan">The watchlist is empty.</Empty> : null}
            </div>
          )}
        </Card>

        <Card title="Recorded signals" meta="Signals the engine stored, newest first" actions={<Badge>{signals.length}</Badge>} bodyClass="flush">
          {terminal.isLoading ? (
            <LoadingRows rows={4} />
          ) : signals.length ? (
            <ul className="list">
              {signals.map((s) => (
                <SignalRow key={s.id} signal={s} currency={ccy} />
              ))}
            </ul>
          ) : (
            <Empty icon={Radar} title="No signals recorded">
              Run an engine cycle to analyse the watchlist now. Signals are stored once a playbook scores near the confidence floor.
            </Empty>
          )}
        </Card>
      </div>
    </>
  );
}
