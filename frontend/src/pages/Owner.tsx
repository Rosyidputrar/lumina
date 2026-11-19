import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, API_BASE, errorText } from '../lib/api';
import { keys } from '../lib/queries';
import { ago, date, dateTime, num, words } from '../lib/format';
import type { IssuedLicence, OwnerLicence } from '../lib/types';
import { Badge, Button, ConfirmDialog, Dialog, Empty, ErrorState, Field, LoadingRows, Notice, Segmented, Switch, Tabs, fieldProps } from '../components/ui';
import { useToast } from '../components/Toast';

type Tab = 'licences' | 'engine' | 'risk' | 'markets' | 'ai' | 'audit';

export function Owner() {
  const [tab, setTab] = useState<Tab>('licences');
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Owner console</h2>
          <p>Issue and manage licences, and set how the engine trades for every device on this server.</p>
        </div>
        <a className="btn btn--ghost" href={`${API_BASE}/console`} target="_blank" rel="noopener noreferrer">
          MT5 gateway console <ExternalLink aria-hidden="true" />
        </a>
      </div>
      <section className="card" aria-label="Owner sections">
        <div style={{ padding: '0 var(--s-4)' }}>
          <Tabs
            label="Owner sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'licences', label: 'Licences' },
              { value: 'engine', label: 'Engine' },
              { value: 'risk', label: 'Risk limits' },
              { value: 'markets', label: 'Markets' },
              { value: 'ai', label: 'AI provider' },
              { value: 'audit', label: 'Audit trail' },
            ]}
          />
        </div>
        <div role="tabpanel">
          {tab === 'licences' ? <Licences /> : tab === 'engine' ? <EngineControl /> : tab === 'risk' ? <RiskLimits /> : tab === 'markets' ? <MarketsEditor /> : tab === 'ai' ? <AiProvider /> : <Audit />}
        </div>
      </section>
    </>
  );
}

/* ---------------------------------------------------------------- licences */

interface LicencesResponse {
  licences: OwnerLicence[];
  summary: { total: number; active: number; revoked: number; expired: number; consumed: number };
  plans: Record<string, { id: string; label: string; days: number | null; defaultQuota: number | null }>;
}

function Licences() {
  const q = useQuery({ queryKey: keys.owner('licences'), queryFn: () => api.get<LicencesResponse>('/api/owner/licences') });
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedLicence | null>(null);
  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { licences, summary, plans } = q.data!;
  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="card-body row-between" style={{ flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 'var(--s-5)' }}>
          <span className="small"><span className="muted">Active </span><span className="num">{summary.active}</span></span>
          <span className="small"><span className="muted">Revoked </span><span className="num">{summary.revoked}</span></span>
          <span className="small"><span className="muted">Expired </span><span className="num">{summary.expired}</span></span>
          <span className="small"><span className="muted">Credits used </span><span className="num">{num(summary.consumed, 0)}</span></span>
        </div>
        <Button variant="primary" onClick={() => setIssuing(true)}>
          <Plus aria-hidden="true" /> Issue licence
        </Button>
      </div>
      {issued ? (
        <div style={{ padding: '0 var(--s-5) var(--s-5)' }}>
          <IssuedKey licence={issued} onDismiss={() => setIssued(null)} />
        </div>
      ) : null}
      {licences.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Licence</th>
                <th scope="col">Plan</th>
                <th scope="col" className="r">Credits</th>
                <th scope="col" className="hide-sm">Expires</th>
                <th scope="col" className="hide-sm">Last seen</th>
                <th scope="col">Status</th>
                <th scope="col" className="r"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {licences.map((l) => (
                <LicenceRow key={l.keyId} l={l} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon={KeyRound} title="No licences issued yet" action={<Button variant="primary" onClick={() => setIssuing(true)}>Issue the first licence</Button>}>
          A licence key activates one customer's terminal with a plan, a credit quota and an expiry.
        </Empty>
      )}
      <IssueDialog open={issuing} plans={plans} onClose={() => setIssuing(false)} onIssued={setIssued} />
    </div>
  );
}

function IssuedKey({ licence, onDismiss }: { licence: IssuedLicence; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Notice kind="ok" title={`Licence issued${licence.label ? ` for ${licence.label}` : ''}`} action={<Button size="sm" variant="ghost" onClick={onDismiss}>Done</Button>}>
      <span className="stack-sm" style={{ display: 'grid', marginTop: 6 }}>
        <span>Send this key to the customer. It is shown in full only now.</span>
        <span className="keybox">
          <span>{licence.readableKey}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(licence.readableKey);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy key'}
          </Button>
        </span>
      </span>
    </Notice>
  );
}

function IssueDialog({ open, plans, onClose, onIssued }: { open: boolean; plans: LicencesResponse['plans']; onClose: () => void; onIssued: (l: IssuedLicence) => void }) {
  const qc = useQueryClient();
  const [plan, setPlan] = useState('monthly');
  const [label, setLabel] = useState('');
  const [quota, setQuota] = useState('');
  const [days, setDays] = useState('');
  const [errors, setErrors] = useState<{ quota?: string; days?: string; form?: string }>({});
  const spec = plans[plan];
  const issue = useMutation({
    mutationFn: () => api.post<{ licence: IssuedLicence }>('/api/owner/licences', { plan, label: label.trim(), quota: quota === '' ? null : Number(quota), days: days === '' ? null : Number(days) }),
    onSuccess: (r) => {
      onIssued(r.licence);
      qc.invalidateQueries({ queryKey: keys.owner('licences') });
      setLabel('');
      setQuota('');
      setDays('');
      onClose();
    },
    onError: (e) => setErrors({ form: errorText(e) }),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (quota !== '' && !(Number(quota) >= 1 && Number.isInteger(Number(quota)))) next.quota = 'Write a whole number of credits, or leave it empty for the plan default.';
    if (days !== '' && !(Number(days) >= 1)) next.days = 'Write a number of days, or leave it empty for the plan default.';
    setErrors(next);
    if (next.quota || next.days) return;
    issue.mutate();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Issue a licence" description="The key is signed by this server and works only here.">
      <form className="form-grid" onSubmit={submit} noValidate>
        <div className="field">
          <span className="field-label">Plan</span>
          <Segmented label="Plan" className="block" value={plan} onChange={setPlan} options={Object.values(plans).map((p) => ({ value: p.id, label: p.label }))} />
          <span className="field-hint">
            {spec ? `${spec.days === null ? 'No expiry' : `${spec.days} days`} · ${spec.defaultQuota === null ? 'unlimited credits' : `${num(spec.defaultQuota, 0)} credits`} by default` : null}
          </span>
        </div>
        <Field label="Label" htmlFor="lic-label" hint="Who or what it is for, for example a name or a device.">
          <input className="input" {...fieldProps('lic-label', null, true)} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </Field>
        <div className="form-grid-2">
          <Field label="Credits" htmlFor="lic-quota" error={errors.quota} hint="Empty uses the plan default.">
            <input className="input num" inputMode="numeric" {...fieldProps('lic-quota', errors.quota, true)} value={quota} onChange={(e) => setQuota(e.target.value)} />
          </Field>
          <Field label="Days" htmlFor="lic-days" error={errors.days} hint="Empty uses the plan default.">
            <input className="input num" inputMode="numeric" {...fieldProps('lic-days', errors.days, true)} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        {errors.form ? <Notice kind="error">{errors.form}</Notice> : null}
        <div className="dialog-foot" style={{ padding: 0 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" go busy={issue.isPending}>
            Issue licence
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function LicenceRow({ l }: { l: OwnerLicence }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<'revoke' | 'extend' | 'quota' | null>(null);
  const [days, setDays] = useState('30');
  const [quota, setQuota] = useState(l.quota?.toString() ?? '');
  const done = (msg: string) => {
    toast.success(msg);
    setDialog(null);
    qc.invalidateQueries({ queryKey: keys.owner('licences') });
  };
  const fail = (e: unknown) => toast.error('The licence was not changed', errorText(e));
  const revoke = useMutation({ mutationFn: (revoked: boolean) => api.post(`/api/owner/licences/${l.keyId}/revoke`, { revoked }), onSuccess: (_r, revoked) => done(revoked ? 'Licence revoked' : 'Licence restored'), onError: fail });
  const extend = useMutation({ mutationFn: () => api.post(`/api/owner/licences/${l.keyId}/extend`, { days: Number(days) }), onSuccess: () => done(`Extended by ${days} days`), onError: fail });
  const setQ = useMutation({ mutationFn: (body: { quota?: number | null; reset?: boolean }) => api.post(`/api/owner/licences/${l.keyId}/quota`, body), onSuccess: (_r, b) => done(b.reset ? 'Usage reset to zero' : 'Credits updated'), onError: fail });
  const state = l.revoked ? ['Revoked', 'down'] : l.expired ? ['Expired', 'warn'] : l.remaining === 0 ? ['Out of credits', 'warn'] : ['Active', 'up'];
  return (
    <tr>
      <td>
        <div className="sym">
          <strong>{l.label || 'Unlabelled'}</strong>
          <span className="num">LV-{l.keyId.toUpperCase()}</span>
        </div>
      </td>
      <td>{words(l.plan)}</td>
      <td className="r num">{l.quota === null ? '∞' : `${num(l.used, 0)} / ${num(l.quota, 0)}`}</td>
      <td className="hide-sm small">{l.expiresAt ? date(l.expiresAt) : 'Never'}</td>
      <td className="hide-sm small muted">{l.lastSeen ? ago(l.lastSeen) : 'Never'}</td>
      <td>
        <Badge tone={state[1] as 'up' | 'down' | 'warn'}>{state[0]}</Badge>
      </td>
      <td className="r">
        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 4 }}>
          <Button size="sm" variant="ghost" onClick={() => setDialog('extend')}>Extend</Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog('quota')}>Credits</Button>
          {l.revoked ? (
            <Button size="sm" onClick={() => revoke.mutate(false)} busy={revoke.isPending}>Restore</Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setDialog('revoke')}>Revoke</Button>
          )}
        </div>
        <ConfirmDialog open={dialog === 'revoke'} onClose={() => setDialog(null)} onConfirm={() => revoke.mutate(true)} busy={revoke.isPending} danger title={`Revoke ${l.label || l.keyId}?`} confirmLabel="Revoke licence">
          The device is signed out on its next request. Its positions and history stay, and you can restore the licence later.
        </ConfirmDialog>
        <Dialog
          open={dialog === 'extend'}
          onClose={() => setDialog(null)}
          title="Extend the licence"
          description={l.expiresAt ? `Currently ${l.expired ? 'expired on' : 'expires on'} ${date(l.expiresAt)}.` : 'This licence never expires; extending sets an expiry from today.'}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => Number(days) > 0 && extend.mutate()} busy={extend.isPending} disabled={!(Number(days) > 0)}>
                Extend by {days || 0} days
              </Button>
            </>
          }
        >
          <Field label="Days to add" htmlFor={`ext-${l.keyId}`}>
            <input id={`ext-${l.keyId}`} className="input num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </Dialog>
        <Dialog
          open={dialog === 'quota'}
          onClose={() => setDialog(null)}
          title="Credits"
          description={`${num(l.used, 0)} used${l.quota === null ? ', no limit' : ` of ${num(l.quota, 0)}`}.`}
          footer={
            <>
              <Button onClick={() => setQ.mutate({ reset: true })} busy={setQ.isPending}>Reset usage</Button>
              <Button variant="primary" onClick={() => setQ.mutate({ quota: quota === '' ? null : Number(quota) })} busy={setQ.isPending} disabled={quota !== '' && !(Number(quota) >= 0)}>
                Save credits
              </Button>
            </>
          }
        >
          <Field label="Credit limit" htmlFor={`q-${l.keyId}`} hint="Empty means unlimited.">
            <input id={`q-${l.keyId}`} className="input num" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} aria-describedby={`q-${l.keyId}-hint`} />
          </Field>
        </Dialog>
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------------- engine */

interface StyleResponse {
  style: string;
  timeframe: string;
  presets: Record<string, { timeframe: string; minRewardRisk: number; minConfidence: number; cooldownMinutes: number; dailyTradeCap: number; label: string }>;
}

function EngineControl() {
  const qc = useQueryClient();
  const toast = useToast();
  const engine = useQuery({ queryKey: keys.owner('engine'), queryFn: () => api.get<{ engine: { running: boolean; cycle: number; lastRun: number | null; timeframe: string; intervalMs: number }; autoTrade: boolean; signals: unknown[]; instruments: { symbol: string; venue: string; price: number | null }[] }>('/api/owner/engine'), refetchInterval: 15_000 });
  const style = useQuery({ queryKey: keys.owner('style'), queryFn: () => api.get<StyleResponse>('/api/owner/style') });
  const scope = useQuery({ queryKey: keys.owner('execution'), queryFn: () => api.get<{ mode: string; symbol: string | null; symbols: string[]; available: string[] }>('/api/owner/execution') });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['owner'] });
    qc.invalidateQueries({ queryKey: keys.terminal });
  };
  const control = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post('/api/owner/engine', body), onSuccess: () => { toast.success('Engine updated'); refresh(); }, onError: (e) => toast.error('The engine was not changed', errorText(e)) });
  const run = useMutation({ mutationFn: () => api.post<{ result: { ms: number } }>('/api/owner/engine/run'), onSuccess: (r) => { toast.success('Cycle finished', `${r.result.ms} ms`); refresh(); }, onError: (e) => toast.error('The cycle did not run', errorText(e)) });
  const setStyle = useMutation({ mutationFn: (s: string) => api.post('/api/owner/style', { style: s }), onSuccess: (_r, s) => { toast.success(`Style set to ${words(s)}`); refresh(); }, onError: (e) => toast.error('The style was not changed', errorText(e)) });
  const [mode, setMode] = useState('all');
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (scope.data) {
      setMode(scope.data.mode);
      setPicked(scope.data.mode === 'single' && scope.data.symbol ? [scope.data.symbol] : scope.data.symbols);
    }
  }, [scope.data]);
  const saveScope = useMutation({
    mutationFn: () => api.post('/api/owner/execution', mode === 'single' ? { mode, symbol: picked[0] } : { mode, symbols: picked }),
    onSuccess: () => { toast.success('Execution scope saved'); refresh(); },
    onError: (e) => toast.error('The scope was not saved', errorText(e)),
  });

  if (engine.isLoading) return <LoadingRows rows={5} />;
  if (engine.isError) return <ErrorState error={engine.error} onRetry={() => engine.refetch()} />;
  const e = engine.data!;
  return (
    <div className="card-body stack" style={{ gap: 'var(--s-6)' }}>
      <div className="stack">
        <div className="row-between">
          <h3>Loop</h3>
          <Badge tone={e.engine.running ? 'up' : ''} dot>{e.engine.running ? 'Running' : 'Stopped'}</Badge>
        </div>
        <p className="small muted">
          Cycle {num(e.engine.cycle, 0)} · last {ago(e.engine.lastRun)} · every {Math.round(e.engine.intervalMs / 1000)} s on {e.engine.timeframe} bars
        </p>
        <div className="row">
          <Button onClick={() => control.mutate({ action: e.engine.running ? 'stop' : 'start' })} busy={control.isPending}>
            {e.engine.running ? 'Stop the loop' : 'Start the loop'}
          </Button>
          <Button variant="primary" onClick={() => run.mutate()} busy={run.isPending}>
            Run one cycle now
          </Button>
        </div>
        <Switch checked={e.autoTrade} onChange={(v) => control.mutate({ autoTrade: v })} label="Auto-trade on the owner account" />
      </div>
      <div className="stack">
        <h3>Trading style</h3>
        <p className="small muted">A preset moves the timeframe, confidence and reward floors, cooldown and daily cap together.</p>
        {style.data ? (
          <div className="grid grid-3" style={{ gap: 'var(--s-3)' }}>
            {Object.entries(style.data.presets).map(([k, p]) => (
              <button
                key={k}
                type="button"
                className="card"
                onClick={() => setStyle.mutate(k)}
                aria-pressed={style.data!.style === k}
                style={{ textAlign: 'left', padding: 'var(--s-4)', cursor: 'pointer', borderColor: style.data!.style === k ? 'var(--action)' : undefined, background: style.data!.style === k ? 'var(--action-soft)' : undefined }}
              >
                <strong style={{ fontWeight: 500 }}>{p.label}</strong>
                <div className="small muted">
                  {p.minConfidence}% conf. · {p.minRewardRisk}R · {p.cooldownMinutes} min cooldown · {p.dailyTradeCap} a day
                </div>
              </button>
            ))}
          </div>
        ) : (
          <LoadingRows rows={2} />
        )}
        {style.data?.style === 'custom' ? <p className="small muted">Current timeframe {style.data.timeframe} does not match a preset.</p> : null}
      </div>
      <div className="stack">
        <h3>Execution scope</h3>
        <p className="small muted">Which watched markets the owner account trades. Customers always see the full watchlist.</p>
        <Segmented label="Scope" value={mode} onChange={setMode} options={[{ value: 'all', label: 'All markets' }, { value: 'single', label: 'One market' }, { value: 'custom', label: 'A selection' }]} />
        {mode !== 'all' ? (
          <div className="chips">
            {(scope.data?.available ?? []).map((s) => {
              const on = picked.includes(s);
              return (
                <button key={s} type="button" className="chip" aria-pressed={on} onClick={() => setPicked(mode === 'single' ? [s] : on ? picked.filter((x) => x !== s) : [...picked, s])} style={on ? { borderColor: 'var(--action)', color: 'var(--action)', background: 'var(--action-soft)' } : undefined}>
                  {s}
                </button>
              );
            })}
          </div>
        ) : null}
        <div>
          <Button onClick={() => saveScope.mutate()} busy={saveScope.isPending} disabled={mode !== 'all' && !picked.length}>
            Save scope
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- risk */

const RISK_LABELS: Record<string, [string, string]> = {
  maxRiskPerTradePct: ['Risk per trade', '% of equity'],
  maxDailyLossPct: ['Daily loss stop', '% of equity, 0 = none'],
  maxPortfolioHeatPct: ['Portfolio heat cap', '% of equity, 0 = none'],
  maxOpenPositions: ['Open positions', '0 = unlimited'],
  maxEntriesPerSymbol: ['Entries per market', 'at most'],
  maxLeverage: ['Book leverage', '× equity, 0 = none'],
  dailyTradeCap: ['Trades per day', '0 = unlimited'],
  cooldownMinutes: ['Cooldown per market', 'minutes'],
  minConfidence: ['Minimum confidence', '%'],
  minRewardRisk: ['Minimum reward/risk', 'R'],
};

function RiskLimits() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: keys.owner('risk'), queryFn: () => api.get<{ limits: Record<string, number>; bounds: Record<string, { min: number; max: number }> }>('/api/owner/risk') });
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setValues(Object.fromEntries(Object.entries(q.data.limits).map(([k, v]) => [k, String(v)])));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.post<{ limits: Record<string, number> }>('/api/owner/risk', Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]))),
    onSuccess: () => {
      toast.success('Risk limits saved', 'They apply to the next order on every account.');
      qc.invalidateQueries({ queryKey: keys.owner('risk') });
      qc.invalidateQueries({ queryKey: keys.terminal });
    },
    onError: (e) => toast.error('Risk limits were not saved', errorText(e)),
  });
  if (q.isLoading) return <LoadingRows rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const bounds = q.data!.bounds;
  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      const n = Number(v);
      const b = bounds[k];
      if (v.trim() === '' || !Number.isFinite(n)) next[k] = 'Write a number.';
      else if (b && (n < b.min || n > b.max)) next[k] = `Between ${b.min} and ${b.max}.`;
    }
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) {
      document.getElementById(`risk-${first}`)?.focus();
      return;
    }
    save.mutate();
  }
  return (
    <form className="card-body form-grid" onSubmit={submit} noValidate>
      <Notice kind="info">Position size always comes from the stop distance and the risk per trade. These limits decide whether an order is allowed at all.</Notice>
      <div className="grid grid-2" style={{ gap: 'var(--s-4)' }}>
        {Object.keys(RISK_LABELS).map((k) => (
          <Field key={k} label={RISK_LABELS[k][0]} htmlFor={`risk-${k}`} error={errors[k]} hint={`${RISK_LABELS[k][1]} · allowed ${bounds[k]?.min} to ${bounds[k]?.max}`}>
            <input className="input num" inputMode="decimal" {...fieldProps(`risk-${k}`, errors[k], true)} value={values[k] ?? ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save risk limits
        </Button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- markets */

interface Market {
  symbol: string;
  venue: string;
  label: string;
  assetClass: string;
}

const VENUES = ['okx', 'kraken', 'bybit', 'mt5'];
const CLASSES = ['crypto', 'fx', 'metal', 'index', 'stock', 'commodity'];

function MarketsEditor() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: keys.owner('markets'), queryFn: () => api.get<{ markets: Market[]; quotes: { symbol: string; price: number }[] }>('/api/owner/markets') });
  const [rows, setRows] = useState<Market[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [remove, setRemove] = useState<number | null>(null);
  useEffect(() => {
    if (q.data) setRows(q.data.markets.map((m) => ({ ...m, label: m.label ?? m.symbol, assetClass: m.assetClass ?? 'crypto' })));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.post('/api/owner/markets', { markets: rows }),
    onSuccess: () => {
      toast.success('Watchlist saved', 'Quotes refresh on the next engine cycle.');
      qc.invalidateQueries({ queryKey: keys.owner('markets') });
      qc.invalidateQueries({ queryKey: keys.terminal });
    },
    onError: (e) => setError(errorText(e)),
  });
  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const quoted = new Map(q.data!.quotes.map((x) => [x.symbol, x.price]));
  const update = (i: number, patch: Partial<Market>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  function submit(e: FormEvent) {
    e.preventDefault();
    const cleaned = rows.filter((r) => r.symbol.trim());
    const dup = cleaned.find((r, i) => cleaned.findIndex((x) => x.symbol.trim() === r.symbol.trim()) !== i);
    if (!cleaned.length) return setError('Keep at least one market.');
    if (dup) return setError(`${dup.symbol} is listed twice.`);
    if (cleaned.length > 24) return setError('At most 24 markets.');
    setError(null);
    save.mutate();
  }
  return (
    <form className="card-body stack" onSubmit={submit} noValidate>
      <p className="small muted measure">Symbols are the venue's own: BTC-USDT on OKX, EURUSD on Kraken, BTCUSDT on Bybit, or the broker's name on MT5 (EURUSD.s, XAUUSDm). A wrong name shows no price rather than another market's.</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Symbol</th>
              <th scope="col">Venue</th>
              <th scope="col">Label</th>
              <th scope="col">Class</th>
              <th scope="col" className="r">Last price</th>
              <th scope="col"><span className="visually-hidden">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input className="input num" aria-label={`Symbol ${i + 1}`} value={r.symbol} onChange={(e) => update(i, { symbol: e.target.value })} style={{ minWidth: 120 }} /></td>
                <td>
                  <select className="select" aria-label={`Venue ${i + 1}`} value={r.venue} onChange={(e) => update(i, { venue: e.target.value })}>
                    {VENUES.map((v) => <option key={v} value={v}>{v.toUpperCase()}</option>)}
                  </select>
                </td>
                <td><input className="input" aria-label={`Label ${i + 1}`} value={r.label} onChange={(e) => update(i, { label: e.target.value })} maxLength={40} style={{ minWidth: 140 }} /></td>
                <td>
                  <select className="select" aria-label={`Class ${i + 1}`} value={r.assetClass} onChange={(e) => update(i, { assetClass: e.target.value })}>
                    {[...new Set([...CLASSES, r.assetClass])].map((c) => <option key={c} value={c}>{words(c)}</option>)}
                  </select>
                </td>
                <td className="r num">{quoted.has(r.symbol) ? quoted.get(r.symbol) : <span className="muted">—</span>}</td>
                <td className="r">
                  <Button variant="ghost" icon size="sm" onClick={() => setRemove(i)} aria-label={`Remove ${r.symbol || 'row'}`} disabled={rows.length <= 1}>
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="row">
        <Button onClick={() => setRows([...rows, { symbol: '', venue: 'okx', label: '', assetClass: 'crypto' }])} disabled={rows.length >= 24}>
          <Plus aria-hidden="true" /> Add market
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save watchlist
        </Button>
      </div>
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        onConfirm={() => {
          setRows(rows.filter((_, j) => j !== remove));
          setRemove(null);
        }}
        title={`Remove ${remove !== null ? rows[remove]?.symbol || 'this row' : ''}?`}
        confirmLabel="Remove from list"
      >
        It leaves the list when you save. Open positions on it keep their last price until you close them.
      </ConfirmDialog>
    </form>
  );
}

/* ---------------------------------------------------------------- ai */

function AiProvider() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: keys.owner('ai'), queryFn: () => api.get<{ config: { provider: string; baseUrl: string; model: string; mode: string; label: string; keyHint: string; hasKey: boolean } }>('/api/owner/ai/settings') });
  const [form, setForm] = useState({ provider: 'local', baseUrl: '', model: '', apiKey: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setForm({ provider: q.data.config.provider, baseUrl: q.data.config.baseUrl, model: q.data.config.model, apiKey: '' });
  }, [q.data]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/api/owner/ai/settings', body),
    onSuccess: () => {
      toast.success('AI provider saved');
      setForm((f) => ({ ...f, apiKey: '' }));
      qc.invalidateQueries({ queryKey: keys.owner('ai') });
      qc.invalidateQueries({ queryKey: keys.aiStatus });
    },
    onError: (e) => setError(errorText(e)),
  });
  if (q.isLoading) return <LoadingRows rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data!.config;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (form.provider !== 'local' && form.baseUrl && !/^https:\/\//i.test(form.baseUrl)) return setError('The base URL must start with https://');
    if (form.provider !== 'local' && !form.model.trim()) return setError('Name the model, for example claude-sonnet-5-5 or deepseek-chat.');
    setError(null);
    save.mutate({ provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
  }
  return (
    <form className="card-body form-grid" onSubmit={submit} noValidate>
      <Notice kind={c.mode === 'local' ? 'info' : 'ok'} title={`Now answering: ${c.label}`}>
        {c.hasKey ? `A key ending in ${c.keyHint.replace('…', '')} is stored on the server. It is never sent back to the browser.` : 'No key is stored. Without one the deterministic local reasoner answers.'}
      </Notice>
      <div className="field">
        <span className="field-label">Provider</span>
        <Segmented
          label="Provider"
          value={form.provider === 'claude' || form.provider === 'local' ? form.provider : 'openai'}
          onChange={(v) => setForm({ ...form, provider: v, baseUrl: v === 'claude' ? 'https://api.anthropic.com' : v === 'local' ? form.baseUrl : form.baseUrl.includes('anthropic') ? '' : form.baseUrl })}
          options={[{ value: 'local', label: 'Local' }, { value: 'claude', label: 'Anthropic' }, { value: 'openai', label: 'OpenAI-compatible' }]}
        />
      </div>
      {form.provider !== 'local' ? (
        <>
          <Field label="Base URL" htmlFor="ai-url" hint={form.provider === 'claude' ? 'https://api.anthropic.com' : 'The API root, for example https://api.deepseek.com'}>
            <input className="input" {...fieldProps('ai-url', null, true)} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} inputMode="url" />
          </Field>
          <Field label="Model" htmlFor="ai-model">
            <input className="input num" id="ai-model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={form.provider === 'claude' ? 'claude-sonnet-5-5' : 'deepseek-chat'} />
          </Field>
          <Field label="API key" htmlFor="ai-key" hint={c.hasKey ? 'Leave empty to keep the stored key.' : 'Stored on the server, write-only.'}>
            <input className="input" type="password" {...fieldProps('ai-key', null, true)} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="off" />
          </Field>
        </>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="row">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save provider
        </Button>
        {c.hasKey ? (
          <Button variant="danger" onClick={() => save.mutate({ clearKey: true })} disabled={save.isPending}>
            Remove stored key
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- audit */

function Audit() {
  const q = useQuery({ queryKey: keys.owner('events'), queryFn: () => api.get<{ audit: { id: number; ts: number; actor: string; action: string; user_id: string | null; ip: string | null; detail: string | null }[] }>('/api/owner/events', { limit: 150 }), refetchInterval: 30_000 });
  if (q.isLoading) return <LoadingRows rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data!.audit;
  if (!rows.length) return <Empty title="Nothing recorded yet" />;
  return (
    <div className="table-wrap scroll-y" style={{ maxHeight: 620 }}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Actor</th>
            <th scope="col">Action</th>
            <th scope="col" className="hide-sm">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="num small">{dateTime(r.ts)}</td>
              <td className="small">{words(r.actor)}{r.user_id ? <span className="muted"> · {r.user_id.replace(/^lic_/, '')}</span> : null}</td>
              <td className="small">{words(r.action)}</td>
              <td className="hide-sm small muted truncate" style={{ maxWidth: 420 }} title={r.detail ?? ''}>{r.detail && r.detail !== 'null' ? r.detail : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
