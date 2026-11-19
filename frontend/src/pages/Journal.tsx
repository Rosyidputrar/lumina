import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, NotebookPen } from 'lucide-react';
import { api } from '../lib/api';
import { keys, useTerminal } from '../lib/queries';
import { dateTime, fixed, money, num, pct, price, qty, signed, tone, words } from '../lib/format';
import type { JournalResponse } from '../lib/types';
import { Badge, Button, Card, Empty, ErrorState, LoadingRows, SideBadge, Stat, Tabs } from '../components/ui';
import { ClosedTable } from '../components/trading';

type Tab = 'trades' | 'orders' | 'markets';

/** CSV with proper quoting, built in the browser from the journal already loaded. */
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

export function Journal() {
  const [tab, setTab] = useState<Tab>('trades');
  const terminal = useTerminal();
  const q = useQuery({ queryKey: keys.journal, queryFn: () => api.get<JournalResponse>('/api/journal') });
  const ccy = terminal.data?.account.currency ?? 'USD';

  const byMarket = useMemo(() => {
    const m = new Map<string, { symbol: string; trades: number; wins: number; pnl: number }>();
    for (const p of q.data?.closed ?? []) {
      const r = m.get(p.symbol) ?? { symbol: p.symbol, trades: 0, wins: 0, pnl: 0 };
      r.trades++;
      if ((p.pnl ?? 0) > 0) r.wins++;
      r.pnl += p.pnl ?? 0;
      m.set(p.symbol, r);
    }
    return [...m.values()].sort((a, b) => b.pnl - a.pnl);
  }, [q.data]);

  function exportCsv() {
    const rows = (q.data?.closed ?? []).map((p) => ({ closed_at: new Date(p.closed_at ?? 0).toISOString(), symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, exit: p.exit_price, pnl: p.pnl, fees: p.fees, reason: p.close_reason, mode: p.mode }));
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lumina-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (q.isLoading) return <LoadingRows rows={8} label="Loading the journal" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { stats, closed, orders } = q.data!;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Trade journal</h2>
          <p>Every closed trade, net of fees on both legs. Each one is also written to the vault as an anonymous lesson.</p>
        </div>
        <Button onClick={exportCsv} disabled={!closed.length}>
          <Download aria-hidden="true" /> Export CSV
        </Button>
      </div>
      <section className="card" aria-label="Performance">
        <div className="stat-strip">
          <Stat label="Net result" value={<span className={tone(stats.netPnl)}>{signed(stats.netPnl)}</span>} sub={`${ccy} over ${stats.trades} trade${stats.trades === 1 ? '' : 's'}`} />
          <Stat label="Win rate" value={pct(stats.winRate, 1)} sub={stats.trades ? `${Math.round((stats.winRate / 100) * stats.trades)} winning` : 'No trades yet'} />
          <Stat label="Profit factor" value={stats.profitFactor === null ? '—' : fixed(stats.profitFactor)} sub="Gross wins ÷ gross losses" />
          <Stat label="Average win / loss" value={<span className="small" style={{ fontSize: 18 }}><span className="up">{fixed(stats.avgWin)}</span> / <span className="down">{fixed(stats.avgLoss)}</span></span>} sub={stats.best ? `Best ${stats.best.symbol} ${signed(stats.best.pnl)}` : '—'} />
        </div>
      </section>
      <section className="card" aria-label="Journal entries">
        <div style={{ padding: '0 var(--s-4)' }}>
          <Tabs label="Journal views" value={tab} onChange={setTab} tabs={[{ value: 'trades', label: `Trades (${closed.length})` }, { value: 'markets', label: 'By market' }, { value: 'orders', label: `Orders (${orders.length})` }]} />
        </div>
        <div role="tabpanel">
          {!closed.length && tab !== 'orders' ? (
            <Empty icon={NotebookPen} title="The journal fills as trades close">Close a position, or let the engine hit a stop or target, and the result is recorded here.</Empty>
          ) : tab === 'trades' ? (
            <ClosedTable rows={closed} />
          ) : tab === 'markets' ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Market</th>
                    <th scope="col" className="r">Trades</th>
                    <th scope="col" className="r">Win rate</th>
                    <th scope="col" className="r">Net result</th>
                  </tr>
                </thead>
                <tbody>
                  {byMarket.map((m) => (
                    <tr key={m.symbol}>
                      <td>{m.symbol}</td>
                      <td className="r num">{m.trades}</td>
                      <td className="r num">{pct((m.wins / m.trades) * 100, 1)}</td>
                      <td className={`r num ${tone(m.pnl)}`}>{money(m.pnl, ccy, { sign: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : orders.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Market</th>
                    <th scope="col">Side</th>
                    <th scope="col" className="r">Size</th>
                    <th scope="col" className="r">Fill</th>
                    <th scope="col" className="r hide-sm">Fee</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="num small">{dateTime(o.created_at)}</td>
                      <td>{o.symbol}</td>
                      <td><SideBadge side={o.side} /></td>
                      <td className="r num">{qty(o.qty)}</td>
                      <td className="r num">{price(o.avg_fill)}</td>
                      <td className="r num hide-sm">{num(o.fees, 4)}</td>
                      <td>
                        <Badge tone={o.status === 'filled' ? 'up' : o.status === 'rejected' ? 'down' : ''}>{words(o.status)}</Badge>
                        <span className="small muted"> {o.mode}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={NotebookPen} title="No orders yet" />
          )}
        </div>
      </section>
      {closed.length ? (
        <Card title="Largest results">
          <dl className="kv">
            <dt>Best trade</dt>
            <dd className="up">{stats.best ? `${stats.best.symbol} ${stats.best.side} ${signed(stats.best.pnl)} · ${dateTime(stats.best.closed_at)}` : '—'}</dd>
            <dt>Worst trade</dt>
            <dd className="down">{stats.worst ? `${stats.worst.symbol} ${stats.worst.side} ${signed(stats.worst.pnl)} · ${dateTime(stats.worst.closed_at)}` : '—'}</dd>
          </dl>
        </Card>
      ) : null}
    </>
  );
}
