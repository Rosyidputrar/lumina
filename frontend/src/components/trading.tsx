import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, X } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { invalidateBook } from '../lib/queries';
import { ago, dateTime, fixed, pct, price, qty, signed, tone, words } from '../lib/format';
import type { Position, Quote, Signal } from '../lib/types';
import { Badge, Button, ConfirmDialog, Dialog, Field, PnL, SideBadge, fieldProps } from './ui';
import { useToast } from './Toast';

/* ---------------------------------------------------------------- quotes */

export function QuoteTable({ quotes, onSelect, selected, compact }: { quotes: Quote[]; onSelect?: (q: Quote) => void; selected?: string; compact?: boolean }) {
  const navigate = useNavigate();
  const open = (q: Quote) => (onSelect ? onSelect(q) : navigate(`/markets?symbol=${encodeURIComponent(q.symbol)}`));
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col" className="r">
              Price
            </th>
            <th scope="col" className="r">
              Change
            </th>
            {!compact ? (
              <th scope="col" className="r hide-sm">
                Range
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={`${q.venue}:${q.symbol}`} className="clickable" aria-selected={selected === q.symbol} onClick={() => open(q)}>
              <td>
                <button
                  type="button"
                  className="sym"
                  style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    open(q);
                  }}
                  aria-label={`${q.label}, ${price(q.price)}, open chart`}
                >
                  <strong>{q.label}</strong>
                  <span>
                    {q.symbol} · {q.venue.toUpperCase()}
                    {q.stale ? ' · stale' : ''}
                  </span>
                </button>
              </td>
              <td className="r num">{price(q.price)}</td>
              <td className={`r num ${tone(q.changePct)}`}>{pct(q.changePct, 2, { sign: true })}</td>
              {!compact ? (
                <td className="r num muted hide-sm">
                  {price(q.low)} – {price(q.high)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- positions */

export function PositionsTable({ positions, currency, empty }: { positions: Position[]; currency: string; empty?: React.ReactNode }) {
  const [closing, setClosing] = useState<Position | null>(null);
  const [editing, setEditing] = useState<Position | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const close = useMutation({
    mutationFn: (p: Position) => api.post<{ pnl: number; exitPrice: number }>(`/api/positions/${p.id}/close`),
    onSuccess: (r, p) => {
      toast.success(`${p.symbol} closed`, `Exit ${price(r.exitPrice)}, result ${signed(r.pnl)} ${currency}`);
      setClosing(null);
      invalidateBook(qc);
    },
    onError: (e) => toast.error('The position was not closed', errorText(e)),
  });

  if (!positions.length) return <>{empty}</>;

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Side</th>
              <th scope="col" className="r">
                Size
              </th>
              <th scope="col" className="r">
                Entry
              </th>
              <th scope="col" className="r">
                Mark
              </th>
              <th scope="col" className="r hide-sm">
                Stop / target
              </th>
              <th scope="col" className="r">
                P&amp;L
              </th>
              <th scope="col" className="r">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="sym">
                    <Link to={`/markets?symbol=${encodeURIComponent(p.symbol)}`} style={{ textDecoration: 'none' }}>
                      <strong>{p.symbol}</strong>
                    </Link>
                    <span>
                      {p.mode === 'live' ? 'Live' : 'Paper'} · {ago(p.opened_at)}
                    </span>
                  </div>
                </td>
                <td>
                  <SideBadge side={p.side} />
                </td>
                <td className="r num">{qty(p.qty)}</td>
                <td className="r num">{price(p.entry)}</td>
                <td className="r num">{price(p.mark)}</td>
                <td className="r num muted hide-sm">
                  {price(p.stop)} / {price(p.target)}
                </td>
                <td className="r">
                  <div style={{ display: 'grid', lineHeight: 1.25 }}>
                    <PnL value={p.unrealised}>{signed(p.unrealised)}</PnL>
                    <span className={`small num ${tone(p.rMultiple)}`}>{p.rMultiple === null || p.rMultiple === undefined ? pct(p.unrealisedPct, 2, { sign: true }) : `${signed(p.rMultiple)}R`}</span>
                  </div>
                </td>
                <td className="r">
                  <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 4 }}>
                    <Button variant="ghost" icon size="sm" onClick={() => setEditing(p)} aria-label={`Edit stop and target for ${p.symbol}`}>
                      <Pencil />
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setClosing(p)}>
                      <X aria-hidden="true" /> Close
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={Boolean(closing)}
        onClose={() => setClosing(null)}
        onConfirm={() => closing && close.mutate(closing)}
        busy={close.isPending}
        danger
        title={closing ? `Close ${closing.side} ${closing.symbol}?` : 'Close position'}
        confirmLabel="Close at market"
      >
        {closing ? (
          <>
            {qty(closing.qty)} at the next {closing.mode === 'live' ? 'broker' : 'paper'} fill. Marked now at {price(closing.mark)}, open result{' '}
            <span className={tone(closing.unrealised)}>
              {signed(closing.unrealised)} {currency}
            </span>
            . Fees are deducted on close.
          </>
        ) : null}
      </ConfirmDialog>
      {editing ? <AmendDialog position={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function AmendDialog({ position, onClose }: { position: Position; onClose: () => void }) {
  const [stop, setStop] = useState(position.stop?.toString() ?? '');
  const [target, setTarget] = useState(position.target?.toString() ?? '');
  const [errors, setErrors] = useState<{ stop?: string; target?: string; form?: string }>({});
  const qc = useQueryClient();
  const toast = useToast();
  const long = position.side === 'long';

  const save = useMutation({
    mutationFn: (body: { stop?: number; target?: number }) => api.patch(`/api/positions/${position.id}`, body),
    onSuccess: () => {
      toast.success(`${position.symbol} protection updated`);
      invalidateBook(qc);
      onClose();
    },
    onError: (e) => setErrors({ form: errorText(e) }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    const body: { stop?: number; target?: number } = {};
    if (stop.trim()) {
      const v = Number(stop);
      if (!Number.isFinite(v) || v <= 0) next.stop = 'Write the stop as a positive price.';
      else if (long ? v >= position.entry : v <= position.entry) next.stop = long ? `A long's stop must be below the entry (${price(position.entry)}).` : `A short's stop must be above the entry (${price(position.entry)}).`;
      else body.stop = v;
    }
    if (target.trim()) {
      const v = Number(target);
      if (!Number.isFinite(v) || v <= 0) next.target = 'Write the target as a positive price.';
      else if (long ? v <= position.entry : v >= position.entry) next.target = long ? `A long's target must be above the entry (${price(position.entry)}).` : `A short's target must be below the entry (${price(position.entry)}).`;
      else body.target = v;
    }
    if (!next.stop && !next.target && body.stop === undefined && body.target === undefined) next.form = 'Change the stop or the target first.';
    setErrors(next);
    if (next.stop || next.target || next.form) return;
    save.mutate(body);
  }

  return (
    <Dialog open onClose={onClose} title={`Protect ${position.symbol}`} description={`${long ? 'Long' : 'Short'} ${qty(position.qty)} from ${price(position.entry)}, marked at ${price(position.mark)}.`}>
      <form className="form-grid" onSubmit={submit} noValidate>
        <div className="form-grid-2">
          <Field label="Stop loss" htmlFor="amend-stop" error={errors.stop}>
            <input className="input num" inputMode="decimal" {...fieldProps('amend-stop', errors.stop)} value={stop} onChange={(e) => setStop(e.target.value)} />
          </Field>
          <Field label="Take profit" htmlFor="amend-target" error={errors.target}>
            <input className="input num" inputMode="decimal" {...fieldProps('amend-target', errors.target)} value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
        </div>
        {errors.form ? <p className="field-error">{errors.form}</p> : null}
        <div className="dialog-foot" style={{ padding: 0 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save protection
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- signals */

export function SignalRow({ signal, currency }: { signal: Signal; currency: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const exec = useMutation({
    mutationFn: () => api.post<{ qty: number; fill: number }>(`/api/signals/${signal.id}/execute`),
    onSuccess: (r) => {
      toast.success(`${signal.symbol} ${signal.direction} opened`, `${qty(r.qty)} filled at ${price(r.fill)} on paper`);
      setConfirm(false);
      invalidateBook(qc);
    },
    onError: (e) => {
      setConfirm(false);
      toast.error('The signal was not executed', errorText(e));
    },
  });
  const dismiss = useMutation({
    mutationFn: () => api.post(`/api/signals/${signal.id}/dismiss`),
    onSuccess: () => {
      invalidateBook(qc);
    },
    onError: (e) => toast.error('The signal was not dismissed', errorText(e)),
  });
  const actionable = signal.status === 'new';
  const rr = signal.reward_risk;

  return (
    <li className="stack-sm">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <div className="row" style={{ gap: 'var(--s-2)' }}>
            <strong style={{ fontWeight: 500 }}>{signal.symbol}</strong>
            <SideBadge side={signal.direction} />
            <Badge tone="action">{fixed(signal.confidence, 1)}% conf.</Badge>
            {signal.status !== 'new' ? <Badge>{words(signal.status)}</Badge> : null}
          </div>
          <span className="small muted">
            {words(signal.playbook)} · {signal.timeframe} · {rr ? `${fixed(rr)}R` : '—'} · {ago(signal.created_at)}
          </span>
        </div>
        {actionable ? (
          <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} busy={dismiss.isPending}>
              Dismiss
            </Button>
            <Button size="sm" variant="primary" onClick={() => setConfirm(true)}>
              Execute
            </Button>
          </div>
        ) : null}
      </div>
      <div className="row small num" style={{ gap: 'var(--s-4)' }}>
        <span>
          <span className="muted">Entry </span>
          {price(signal.entry)}
        </span>
        <span>
          <span className="muted">Stop </span>
          <span className="down">{price(signal.stop)}</span>
        </span>
        <span>
          <span className="muted">Target </span>
          <span className="up">{price(signal.target1)}</span>
        </span>
      </div>
      {signal.rationale ? <p className="small" style={{ color: 'var(--ink-2)' }}>{signal.rationale}</p> : null}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => exec.mutate()}
        busy={exec.isPending}
        title={`Execute ${signal.direction} ${signal.symbol}?`}
        confirmLabel="Place paper order"
      >
        The risk gate sizes the order from the stop at {price(signal.stop)} and checks every limit first. It fills at the current price, which may differ from the signal's entry of {price(signal.entry)}. Results are in {currency}.
      </ConfirmDialog>
    </li>
  );
}

export function ClosedTable({ rows }: { rows: Position[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Closed</th>
            <th scope="col">Market</th>
            <th scope="col">Side</th>
            <th scope="col" className="r">
              Size
            </th>
            <th scope="col" className="r">
              Entry → exit
            </th>
            <th scope="col" className="hide-sm">
              Reason
            </th>
            <th scope="col" className="r">
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="num small">{dateTime(p.closed_at)}</td>
              <td>{p.symbol}</td>
              <td>
                <SideBadge side={p.side} />
              </td>
              <td className="r num">{qty(p.qty)}</td>
              <td className="r num">
                {price(p.entry)} → {price(p.exit_price)}
              </td>
              <td className="hide-sm muted small">{words(p.close_reason)}</td>
              <td className="r">
                <PnL value={p.pnl}>{signed(p.pnl)}</PnL>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
