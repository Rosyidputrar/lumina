import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, History, Wallet } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { invalidateBook, keys, useTerminal } from '../lib/queries';
import { ago, money, price, qty, signed, tone } from '../lib/format';
import type { PendingOrder, Position } from '../lib/types';
import { Button, ConfirmDialog, Empty, ErrorState, LoadingRows, SideBadge, Stat, Tabs } from '../components/ui';
import { ClosedTable, PositionsTable } from '../components/trading';
import { useToast } from '../components/Toast';

type Tab = 'open' | 'pending' | 'closed';

export function Positions() {
  const [tab, setTab] = useState<Tab>('open');
  const terminal = useTerminal();
  const book = useQuery({ queryKey: keys.positions, queryFn: () => api.get<{ positions: Position[]; closed: Position[] }>('/api/positions'), refetchInterval: 20_000 });
  const pending = useQuery({ queryKey: keys.pending, queryFn: () => api.get<{ orders: PendingOrder[] }>('/api/pending-orders'), refetchInterval: 30_000 });
  const ccy = terminal.data?.account.currency ?? 'USD';
  const open = book.data?.positions ?? [];
  const closed = book.data?.closed ?? [];
  const unrealised = open.reduce((a, p) => a + (p.unrealised ?? 0), 0);
  const exposure = open.reduce((a, p) => a + (p.notional ?? 0), 0);

  return (
    <>
      <section className="card" aria-label="Book summary">
        <div className="stat-strip">
          <Stat label="Open positions" value={open.length} sub={`${pending.data?.orders.length ?? 0} pending order${pending.data?.orders.length === 1 ? '' : 's'}`} />
          <Stat label="Open P&L" value={<span className={tone(unrealised)}>{signed(unrealised)}</span>} sub={ccy} />
          <Stat label="Exposure" value={money(exposure, null)} sub={`${ccy} notional at mark`} />
          <Stat label="Open risk" value={money(terminal.data?.risk.openRisk, null)} sub={`${terminal.data?.risk.openRiskPct ?? 0}% of equity if every stop is hit`} />
        </div>
      </section>

      <section className="card" aria-label="Positions">
        <div style={{ padding: '0 var(--s-4)' }}>
          <Tabs
            label="Position views"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'open', label: `Open (${open.length})` },
              { value: 'pending', label: `Pending (${pending.data?.orders.length ?? 0})` },
              { value: 'closed', label: 'Closed' },
            ]}
          />
        </div>
        <div role="tabpanel">
          {book.isLoading ? (
            <LoadingRows rows={5} />
          ) : book.isError ? (
            <ErrorState error={book.error} onRetry={() => book.refetch()} />
          ) : tab === 'open' ? (
            <PositionsTable
              positions={open}
              currency={ccy}
              empty={
                <Empty icon={Wallet} title="No open positions" action={<Link className="btn btn--primary btn--go" to="/markets">Open a trade</Link>}>
                  Positions the engine or you open appear here with their live mark and R multiple.
                </Empty>
              }
            />
          ) : tab === 'pending' ? (
            <PendingTable orders={pending.data?.orders ?? []} loading={pending.isLoading} />
          ) : closed.length ? (
            <ClosedTable rows={closed} />
          ) : (
            <Empty icon={History} title="Nothing closed yet">
              Closed trades and their results, net of fees, are listed here and in the journal.
            </Empty>
          )}
        </div>
      </section>
    </>
  );
}

function PendingTable({ orders, loading }: { orders: PendingOrder[]; loading: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<PendingOrder | null>(null);
  const cancel = useMutation({
    mutationFn: (o: PendingOrder) => api.post(`/api/pending-orders/${o.id}/cancel`),
    onSuccess: (_r, o) => {
      toast.success('Pending order cancelled', `${o.side === 'buy' ? 'Buy' : 'Sell'} ${qty(o.qty)} ${o.symbol} at ${price(o.trigger_price)}`);
      setTarget(null);
      invalidateBook(qc);
    },
    onError: (e) => toast.error('The order was not cancelled', errorText(e)),
  });
  if (loading) return <LoadingRows rows={3} />;
  if (!orders.length)
    return (
      <Empty icon={Clock} title="No pending orders" action={<Link className="btn btn--ghost" to="/markets">Place one from Markets</Link>}>
        A pending order waits for its trigger price and fills at market on the next engine cycle after it is touched.
      </Empty>
    );
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Side</th>
              <th scope="col" className="r">Size</th>
              <th scope="col" className="r">Trigger</th>
              <th scope="col" className="r hide-sm">Stop / target</th>
              <th scope="col" className="hide-sm">Placed</th>
              <th scope="col" className="r"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.symbol}</td>
                <td><SideBadge side={o.side} /></td>
                <td className="r num">{qty(o.qty)}</td>
                <td className="r num">{price(o.trigger_price)}</td>
                <td className="r num muted hide-sm">{price(o.stop)} / {price(o.target)}</td>
                <td className="hide-sm small muted">{ago(o.created_at)}</td>
                <td className="r">
                  <Button size="sm" variant="danger" onClick={() => setTarget(o)}>Cancel</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog open={Boolean(target)} onClose={() => setTarget(null)} onConfirm={() => target && cancel.mutate(target)} busy={cancel.isPending} danger title="Cancel this pending order?" confirmLabel="Cancel order">
        {target ? `${target.side === 'buy' ? 'Buy' : 'Sell'} ${qty(target.qty)} ${target.symbol} at ${price(target.trigger_price)} will no longer fill.` : null}
      </ConfirmDialog>
    </>
  );
}
