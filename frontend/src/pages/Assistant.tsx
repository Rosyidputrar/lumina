import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Send, Target } from 'lucide-react';
import { api, ApiError, errorText } from '../lib/api';
import { invalidateBook, keys, useTerminal } from '../lib/queries';
import { fixed, money, num, price, qty, time, words } from '../lib/format';
import type { ChatMessage } from '../lib/types';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, LoadingRows, Notice, Segmented, SideBadge, Tabs, fieldProps } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';
import { useNavigate } from 'react-router-dom';

type Tab = 'chat' | 'trade' | 'goal';

export function Assistant() {
  const [tab, setTab] = useState<Tab>('chat');
  const status = useQuery({ queryKey: keys.aiStatus, queryFn: () => api.get<{ mode: string; label: string; enabled: boolean }>('/api/ai/status') });
  const watcher = useQuery({ queryKey: keys.watcher, queryFn: () => api.get<{ running: boolean; model: string; recent: { ts: number; level?: string; symbol?: string; message?: string; text?: string; note?: string; summary?: string }[] }>('/api/ai/watcher'), refetchInterval: 60_000 });

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Analyst</h2>
          <p>Answers come from the live engine snapshot: the plans, your positions and the risk envelope. It never invents prices, and each question costs one credit.</p>
        </div>
        <Badge tone={status.data?.enabled ? 'action' : ''}>{status.data?.label ?? 'Checking provider…'}</Badge>
      </div>
      <div className="grid grid-main">
        <section className="card" aria-label="Analyst workspace">
          <div style={{ padding: '0 var(--s-4)' }}>
            <Tabs
              label="Analyst tools"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'chat', label: 'Ask' },
                { value: 'trade', label: 'Trade from text' },
                { value: 'goal', label: 'Goal check' },
              ]}
            />
          </div>
          <div role="tabpanel">{tab === 'chat' ? <Chat /> : tab === 'trade' ? <TradeIntent /> : <GoalPlanner />}</div>
        </section>
        <div className="stack" style={{ gap: 'var(--s-5)' }}>
          <Card title="How answers are made">
            <ul className="stack-sm small" style={{ margin: 0, paddingLeft: '1.1em', color: 'var(--ink-2)' }}>
              <li>The question is answered from up to six watched markets, analysed on your timeframe.</li>
              <li>The vault and the engine's memory are searched first, so answers improve as lessons accumulate.</li>
              <li>{status.data?.mode === 'local' ? 'No AI provider is configured, so a deterministic local reasoner writes the answer. The owner can connect a provider.' : `Answers are written by ${status.data?.label ?? 'the configured provider'}, with the local reasoner as a fallback.`}</li>
            </ul>
          </Card>
          <Card title="Market watcher" meta={watcher.data?.running ? `Running on ${watcher.data.model}` : 'Not running'}>
            {watcher.data?.recent?.length ? (
              <ul className="stack-sm small" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {watcher.data.recent.map((n, i) => (
                  <li key={i}>
                    <span className="muted num">{time(n.ts)}</span> {n.symbol ? <strong>{n.symbol} </strong> : null}
                    {n.message ?? n.summary ?? n.text ?? n.note ?? words(n.level)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">The watcher reads the tape between cycles once the owner gives it a model. It has no notes yet.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

const SUGGESTIONS = ['Which market has the best setup right now?', 'Explain my open positions and their risk.', 'Why is the engine not trading?', 'What would invalidate the strongest plan?'];

function Chat() {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const messages = useQuery({ queryKey: keys.messages, queryFn: () => api.get<{ messages: ChatMessage[] }>('/api/ai/messages') });
  const ask = useMutation({
    mutationFn: (question: string) => api.post<{ answer: string; notice?: string }>('/api/ai/ask', { question }),
    onMutate: (q) => setPending(q),
    onSettled: () => setPending(null),
    onSuccess: (r) => {
      if (r.notice) toast.info('Answered locally', r.notice);
      qc.invalidateQueries({ queryKey: keys.messages });
      qc.invalidateQueries({ queryKey: keys.terminal });
    },
    onError: (e, q) => {
      setText(q);
      toast.error('The analyst did not answer', errorText(e));
    },
  });

  const list = messages.data?.messages ?? [];
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [list.length, pending]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const q = text.trim();
    if (q.length < 2 || ask.isPending) return;
    setText('');
    ask.mutate(q);
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={log} aria-live="polite" aria-busy={ask.isPending}>
        {messages.isLoading ? (
          <LoadingRows rows={3} />
        ) : messages.isError ? (
          <ErrorState error={messages.error} onRetry={() => messages.refetch()} />
        ) : !list.length && !pending ? (
          <Empty icon={Bot} title="Ask about the markets you watch">
            <span className="chips" style={{ justifyContent: 'center', marginTop: 8 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => ask.mutate(s)}>
                  {s}
                </button>
              ))}
            </span>
          </Empty>
        ) : (
          <>
            {list.map((m) => (
              <div key={m.id} className={`msg ${m.role === 'user' ? 'msg-user' : ''}`}>
                <div className="msg-bubble">{m.role === 'user' ? m.content : <Markdown text={m.content} className="" />}</div>
                <span className="msg-meta">
                  {m.role === 'user' ? 'You' : m.provider === 'owner' ? 'Support' : (m.provider ?? 'Analyst')} · {time(m.ts)}
                </span>
              </div>
            ))}
            {pending ? (
              <>
                <div className="msg msg-user">
                  <div className="msg-bubble">{pending}</div>
                </div>
                <div className="msg">
                  <div className="msg-bubble row" style={{ gap: 8 }}>
                    <span className="spinner" aria-hidden="true" /> Reading the engine snapshot…
                  </div>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <label htmlFor="ask" className="visually-hidden">
          Your question
        </label>
        <textarea
          id="ask"
          className="textarea"
          rows={1}
          maxLength={2000}
          placeholder="Ask about a market, a plan or your positions"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button type="submit" variant="primary" icon aria-label="Send question" busy={ask.isPending} disabled={text.trim().length < 2}>
          {ask.isPending ? null : <Send />}
        </Button>
      </form>
    </div>
  );
}

interface Proposal {
  symbol: string;
  venue: string;
  timeframe: string;
  side: 'buy' | 'sell';
  mode: string;
  entry: number;
  stop: number;
  target: number;
  qty: number;
  rewardRisk: number;
  confidence: number;
  playbook: string;
  thesis: string;
  estimatedProfit: number;
  risk: { riskAmount: number; qty: number } | null;
  warning: string;
  discovered?: { symbol: string };
}

function TradeIntent() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const terminal = useTerminal();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const ccy = terminal.data?.account.currency ?? 'USD';
  const propose = useMutation({
    mutationFn: (t: string) => api.post<Proposal>('/api/ai/trade-intent', { text: t }),
    onMutate: () => setError(null),
    onError: (e) => setError(e instanceof ApiError && e.code === 'NO_SETUP' ? `${e.message}. Try another market or timeframe.` : errorText(e)),
  });
  const place = useMutation({
    mutationFn: (p: Proposal) => api.post<{ fill: number }>('/api/positions', { symbol: p.symbol, side: p.side, qty: Number(p.qty.toPrecision(8)), stop: p.stop, target: p.target }),
    onSuccess: (r, p) => {
      toast.success(`${p.side === 'buy' ? 'Bought' : 'Sold'} ${qty(p.qty)} ${p.symbol}`, `Filled at ${price(r.fill)}`);
      setConfirm(false);
      propose.reset();
      invalidateBook(qc);
    },
    onError: (e) => {
      setConfirm(false);
      toast.error('The order was not placed', errorText(e));
    },
  });
  const p = propose.data;

  return (
    <div className="card-body stack">
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length < 3) {
            setError('Describe the trade, for example "buy BTC-USDT 1h" or "best market".');
            return;
          }
          propose.mutate(text.trim());
        }}
        noValidate
      >
        <Field label="Describe the trade" htmlFor="intent" error={error} hint="Name a watched market and a side, or ask for the best market. Add 'lot 0.5' or 'entries 3' to size it.">
          <input className="input" {...fieldProps('intent', error, true)} value={text} onChange={(e) => setText(e.target.value)} placeholder="Sell EURUSD 15m lot 1000" />
        </Field>
        <div className="row">
          <Button type="submit" variant="primary" go busy={propose.isPending}>
            Build a proposal
          </Button>
          <span className="small muted">Costs one credit. Nothing is sent until you confirm.</span>
        </div>
      </form>
      {p ? (
        <div className="card" style={{ background: 'var(--surface)' }}>
          <div className="card-body stack">
            <div className="row" style={{ gap: 'var(--s-2)' }}>
              <h3>{p.symbol}</h3>
              <SideBadge side={p.side} />
              <Badge tone="action">{fixed(p.confidence, 1)}%</Badge>
              <Badge>{fixed(p.rewardRisk)}R</Badge>
              <Badge>{words(p.playbook)} · {p.timeframe}</Badge>
            </div>
            {p.thesis ? <p className="small" style={{ color: 'var(--ink-2)' }}>{p.thesis}</p> : null}
            <dl className="kv">
              <dt>Entry (market)</dt>
              <dd>{price(p.entry)}</dd>
              <dt>Stop</dt>
              <dd className="down">{price(p.stop)}</dd>
              <dt>Target</dt>
              <dd className="up">{price(p.target)}</dd>
              <dt>Risk-sized volume</dt>
              <dd>{qty(p.qty)}</dd>
              <dt>Risk if stopped</dt>
              <dd>{money(p.risk?.riskAmount, ccy)}</dd>
              <dt>Estimated result at target</dt>
              <dd>{money(p.estimatedProfit, ccy)}</dd>
            </dl>
            {p.warning ? <Notice kind="warn">{p.warning}</Notice> : null}
            {p.discovered ? <Notice kind="info">{p.discovered.symbol} is not in the watchlist. The owner must add it before it can be traded.</Notice> : null}
            <div className="row">
              <Button variant={p.side === 'buy' ? 'buy' : 'sell'} onClick={() => setConfirm(true)} disabled={Boolean(p.discovered) || !(p.qty > 0)}>
                {p.side === 'buy' ? 'Buy' : 'Sell'} {qty(p.qty)} {p.symbol}
              </Button>
              <Button variant="ghost" onClick={() => navigate(`/markets?symbol=${encodeURIComponent(p.symbol)}`)}>
                Review on the chart
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => p && place.mutate(p)} busy={place.isPending} title={p ? `${p.side === 'buy' ? 'Buy' : 'Sell'} ${p.symbol} at market?` : ''} confirmLabel="Send order">
        {p ? `${qty(p.qty)} with a stop at ${price(p.stop)} and a target at ${price(p.target)}, on ${p.mode === 'live' ? 'the live account' : 'paper'}. The server checks the risk gate again before it fills.` : null}
      </ConfirmDialog>
    </div>
  );
}

interface GoalPlan {
  capital: number;
  target: number;
  targetPctOfCapital: number | null;
  style: string;
  timeframe: string;
  suggestedTradesPerDay: number;
  riskPerTrade: number;
  maxWinPerTrade: number;
  tradesNeededForTarget: number | null;
  feasible: boolean;
  warning: string | null;
}

function GoalPlanner() {
  const terminal = useTerminal();
  const [capital, setCapital] = useState('');
  const [target, setTarget] = useState('');
  const [style, setStyle] = useState<'scalping' | 'intraday' | 'swing'>('intraday');
  const [errors, setErrors] = useState<{ capital?: string; target?: string }>({});
  const ccy = terminal.data?.account.currency ?? 'USD';
  const plan = useMutation({ mutationFn: () => api.post<GoalPlan>('/api/ai/goal', { capital: Number(capital), target: Number(target), style }) });

  useEffect(() => {
    if (!capital && terminal.data) setCapital(String(Math.round(terminal.data.account.equity)));
  }, [terminal.data, capital]);

  return (
    <div className="card-body stack">
      <p className="small muted measure">Check a profit goal against the risk policy before chasing it. The arithmetic uses the server's real per-trade risk and minimum reward/risk.</p>
      <form
        className="form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const next: typeof errors = {};
          if (!(Number(capital) > 0)) next.capital = 'Write the capital as a positive amount.';
          if (!(Number(target) > 0)) next.target = 'Write the profit goal as a positive amount.';
          setErrors(next);
          if (next.capital || next.target) return;
          plan.mutate();
        }}
      >
        <div className="form-grid-2">
          <Field label={`Capital (${ccy})`} htmlFor="goal-cap" error={errors.capital}>
            <input className="input num" inputMode="decimal" {...fieldProps('goal-cap', errors.capital)} value={capital} onChange={(e) => setCapital(e.target.value)} />
          </Field>
          <Field label={`Profit goal (${ccy})`} htmlFor="goal-target" error={errors.target}>
            <input className="input num" inputMode="decimal" {...fieldProps('goal-target', errors.target)} value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
        </div>
        <div className="field">
          <span className="field-label">Style</span>
          <Segmented label="Trading style" value={style} onChange={setStyle} options={[{ value: 'scalping', label: 'Scalping · 5m' }, { value: 'intraday', label: 'Intraday · 15m' }, { value: 'swing', label: 'Swing · 4h' }]} />
        </div>
        <div>
          <Button type="submit" variant="primary" go busy={plan.isPending}>
            Check the goal
          </Button>
        </div>
      </form>
      {plan.isError ? <Notice kind="error">{errorText(plan.error)}</Notice> : null}
      {plan.data ? (
        <div className="card" style={{ background: 'var(--surface)' }}>
          <div className="card-body stack">
            <div className="row" style={{ gap: 'var(--s-2)' }}>
              <Target aria-hidden="true" style={{ width: 18, height: 18, color: plan.data.feasible ? 'var(--up)' : 'var(--down)' }} />
              <h3>{plan.data.feasible ? 'Reachable with discipline' : 'Not realistic under this risk policy'}</h3>
            </div>
            <dl className="kv">
              <dt>Goal as a share of capital</dt>
              <dd>{plan.data.targetPctOfCapital === null ? '—' : `${num(plan.data.targetPctOfCapital, 1)}%`}</dd>
              <dt>Risk per trade</dt>
              <dd>{money(plan.data.riskPerTrade, ccy)}</dd>
              <dt>Best case per winning trade</dt>
              <dd>{money(plan.data.maxWinPerTrade, ccy)}</dd>
              <dt>Winning trades needed</dt>
              <dd>{plan.data.tradesNeededForTarget === null || !Number.isFinite(plan.data.tradesNeededForTarget) ? '—' : num(plan.data.tradesNeededForTarget, 0)}</dd>
              <dt>Typical trades a day ({plan.data.timeframe})</dt>
              <dd>{plan.data.suggestedTradesPerDay}</dd>
            </dl>
            {plan.data.warning ? <Notice kind="warn">{plan.data.warning}</Notice> : null}
            <p className="small muted">This is arithmetic on the policy, not a forecast.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
