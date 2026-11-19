import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText } from '../lib/api';
import { keys, useTerminal } from '../lib/queries';
import { bytes, date, num, words } from '../lib/format';
import { useTheme } from '../lib/theme';
import { useSession } from '../auth/session';
import type { Preferences } from '../lib/types';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Field, LoadingRows, Notice, Segmented, Switch, fieldProps } from '../components/ui';
import { useToast } from '../components/Toast';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];

export function Settings() {
  const session = useSession();
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div className="stack" style={{ gap: 'var(--s-5)' }}>
        <TradingPrefs />
        <LiveTrading />
        {!session.owner ? <BrokerProfile /> : null}
      </div>
      <div className="stack" style={{ gap: 'var(--s-5)' }}>
        <LicenceCard />
        <Appearance />
        <DeviceCard />
        <About />
      </div>
    </div>
  );
}

function TradingPrefs() {
  const qc = useQueryClient();
  const toast = useToast();
  const prefs = useQuery({ queryKey: keys.preferences, queryFn: () => api.get<Preferences>('/api/settings/preferences') });
  const [tf, setTf] = useState('1h');
  const [style, setStyle] = useState('custom');
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (prefs.data) {
      setTf(prefs.data.timeframe);
      setStyle(prefs.data.style);
      setAuto(prefs.data.autoTrade);
    }
  }, [prefs.data]);
  const save = useMutation({
    mutationFn: () => api.post('/api/settings/preferences', { timeframe: tf, style, autoTrade: auto }),
    onSuccess: () => {
      toast.success('Trading preferences saved', `The engine analyses ${tf} bars for you from the next cycle.`);
      qc.invalidateQueries({ queryKey: keys.preferences });
      qc.invalidateQueries({ queryKey: keys.terminal });
    },
    onError: (e) => toast.error('Preferences were not saved', errorText(e)),
  });
  if (prefs.isLoading) return <Card title="Trading"><LoadingRows rows={3} /></Card>;
  if (prefs.isError) return <Card title="Trading"><ErrorState error={prefs.error} onRetry={() => prefs.refetch()} /></Card>;
  const dirty = prefs.data && (prefs.data.timeframe !== tf || prefs.data.style !== style || prefs.data.autoTrade !== auto);
  return (
    <Card title="Trading" meta="Used by your engine cycles, the scanner and the analyst">
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Analysis timeframe" htmlFor="pref-tf" hint="Shorter bars mean more signals and more noise.">
          <select id="pref-tf" className="select" value={tf} onChange={(e) => setTf(e.target.value)} aria-describedby="pref-tf-hint">
            {TIMEFRAMES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>
        <div className="field">
          <span className="field-label">Style</span>
          <Segmented label="Trading style" value={style} onChange={setStyle} options={[{ value: 'custom', label: 'Custom' }, { value: 'scalping', label: 'Scalping' }, { value: 'intraday', label: 'Intraday' }, { value: 'swing', label: 'Swing' }]} />
          <span className="field-hint">A label for your approach. The owner's risk limits apply whichever you pick.</span>
        </div>
        <Switch checked={auto} onChange={setAuto} label="Let the engine open positions for signals that pass the risk gate" />
        <div className="row">
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty}>
            Save preferences
          </Button>
          {!dirty ? <span className="small muted">Saved</span> : null}
        </div>
      </form>
    </Card>
  );
}

function LiveTrading() {
  const session = useSession();
  const terminal = useTerminal();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const live = terminal.data?.live;
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch<{ liveEnabled: boolean }>('/api/account/live', { enabled }),
    onSuccess: (r) => {
      toast.success(r.liveEnabled ? 'Live trading enabled' : 'Back to paper trading', r.liveEnabled ? 'New orders go to the broker account.' : 'New orders fill on the paper ledger.');
      setConfirm(false);
      qc.invalidateQueries({ queryKey: keys.terminal });
    },
    onError: (e) => {
      setConfirm(false);
      toast.error('Live trading was not changed', errorText(e));
    },
  });
  return (
    <Card title="Execution" actions={<Badge tone={live?.mode === 'live' ? 'warn' : 'action'}>{live?.mode === 'live' ? 'Live' : 'Paper'}</Badge>}>
      <div className="stack">
        {session.owner ? (
          <>
            <p className="small" style={{ color: 'var(--ink-2)' }}>
              Live trading needs LUMINA_LIVE=1 and a configured broker on the server. {live?.configured ? `The ${live.broker} broker is ready.` : 'No live broker is configured, so this stays on paper.'}
              {live?.activeAccount ? ` Active MT5 account: ${live.activeAccount.label} (${live.activeAccount.login} on ${live.activeAccount.server}).` : ''}
            </p>
            {live?.enabled ? (
              <Button variant="danger" onClick={() => toggle.mutate(false)} busy={toggle.isPending}>
                Switch back to paper
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setConfirm(true)} disabled={!live?.configured}>
                Enable live trading
              </Button>
            )}
          </>
        ) : (
          <Notice kind="info" title="This licence trades on paper">
            Live trading is only possible once the owner assigns a dedicated broker gateway to this licence. Save your broker details below so the owner can provision it.
          </Notice>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => toggle.mutate(true)} busy={toggle.isPending} danger title="Trade with real money?" confirmLabel="Enable live trading">
        From now on, tickets and auto-trades are sent to the broker account. Leveraged trading can lose more than you expect. Use a demo account first.
      </ConfirmDialog>
    </Card>
  );
}

function BrokerProfile() {
  const qc = useQueryClient();
  const toast = useToast();
  const profile = useQuery({ queryKey: keys.broker, queryFn: () => api.get<{ connected: boolean; status: string; broker?: string; login?: string; server?: string; updatedAt?: number }>('/api/broker/profile') });
  const [form, setForm] = useState({ broker: '', login: '', server: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [remove, setRemove] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post('/api/broker/profile', form),
    onSuccess: () => {
      toast.success('Broker details saved', 'The password is encrypted on the server and never shown again.');
      setForm({ broker: '', login: '', server: '', password: '' });
      qc.invalidateQueries({ queryKey: keys.broker });
    },
    onError: (e) => setErrors({ form: e instanceof ApiError && e.code === 'CREDENTIAL_STORAGE_UNAVAILABLE' ? 'The server cannot store broker passwords safely yet (LUMINA_CREDENTIAL_SECRET is not set). Ask the owner.' : errorText(e) }),
  });
  const del = useMutation({
    mutationFn: () => api.del('/api/broker/profile'),
    onSuccess: () => {
      toast.success('Broker details removed');
      setRemove(false);
      qc.invalidateQueries({ queryKey: keys.broker });
    },
    onError: (e) => toast.error('The details were not removed', errorText(e)),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string | undefined> = {};
    if (!form.broker.trim()) next.broker = 'Write the broker name.';
    if (!form.login.trim()) next.login = 'Write the MT5 login number.';
    if (!form.server.trim()) next.server = 'Write the MT5 server, as MetaTrader shows it.';
    if (form.password.length < 4) next.password = 'Write the account password (4 characters or more).';
    setErrors(next);
    const first = ['broker', 'login', 'server', 'password'].find((k) => next[k]);
    if (first) {
      document.getElementById(`bp-${first}`)?.focus();
      return;
    }
    save.mutate();
  }
  const p = profile.data;
  return (
    <Card title="Broker account" meta="For a future live gateway. Paper trading does not need it." actions={p?.connected ? <Badge tone={p.status === 'connected' ? 'up' : 'warn'}>{words(p.status)}</Badge> : null}>
      {profile.isLoading ? (
        <LoadingRows rows={3} />
      ) : p?.connected ? (
        <div className="stack">
          <dl className="kv">
            <dt>Broker</dt>
            <dd>{p.broker}</dd>
            <dt>Login</dt>
            <dd>{p.login}</dd>
            <dt>Server</dt>
            <dd>{p.server}</dd>
            <dt>Saved</dt>
            <dd>{date(p.updatedAt)}</dd>
          </dl>
          <p className="small muted">The password is stored encrypted and is never returned to the browser. Live trading stays blocked until the owner provisions a gateway for this account.</p>
          <div>
            <Button variant="danger" onClick={() => setRemove(true)}>
              Remove broker details
            </Button>
          </div>
        </div>
      ) : (
        <form className="form-grid" onSubmit={submit} noValidate>
          <div className="form-grid-2">
            <Field label="Broker" htmlFor="bp-broker" error={errors.broker}>
              <input className="input" {...fieldProps('bp-broker', errors.broker)} value={form.broker} onChange={(e) => setForm({ ...form, broker: e.target.value })} autoComplete="organization" />
            </Field>
            <Field label="MT5 login" htmlFor="bp-login" error={errors.login}>
              <input className="input num" inputMode="numeric" {...fieldProps('bp-login', errors.login)} value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} autoComplete="username" />
            </Field>
          </div>
          <Field label="MT5 server" htmlFor="bp-server" error={errors.server}>
            <input className="input" {...fieldProps('bp-server', errors.server)} value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} placeholder="Broker-Live01" />
          </Field>
          <Field label="Password" htmlFor="bp-password" error={errors.password}>
            <input className="input" type="password" {...fieldProps('bp-password', errors.password)} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" />
          </Field>
          {errors.form ? <Notice kind="error">{errors.form}</Notice> : null}
          <div>
            <Button type="submit" variant="primary" busy={save.isPending}>
              Save broker details
            </Button>
          </div>
        </form>
      )}
      <ConfirmDialog open={remove} onClose={() => setRemove(false)} onConfirm={() => del.mutate()} busy={del.isPending} danger title="Remove the broker details?" confirmLabel="Remove details">
        The encrypted password is deleted from the server. You can add the account again later.
      </ConfirmDialog>
    </Card>
  );
}

function LicenceCard() {
  const session = useSession();
  const terminal = useTerminal();
  const l = terminal.data?.licence ?? session.status?.licence;
  const used = l?.quota ? Math.min(100, (l.used / l.quota) * 100) : 0;
  return (
    <Card title="Licence" actions={<Badge tone="action">{session.owner ? 'Owner' : words(l?.plan)}</Badge>}>
      {session.owner ? (
        <p className="small" style={{ color: 'var(--ink-2)' }}>
          The owner terminal has no quota and no expiry. Licences for other devices are issued from the owner console.
        </p>
      ) : l ? (
        <div className="stack">
          <dl className="kv">
            <dt>Label</dt>
            <dd>{l.label ?? '—'}</dd>
            <dt>Credits</dt>
            <dd>{l.quota === null ? 'Unlimited' : `${num(l.remaining ?? 0, 0)} of ${num(l.quota, 0)} left`}</dd>
            <dt>Expires</dt>
            <dd>{l.daysLeft === null ? 'Never' : `${l.daysLeft} day${l.daysLeft === 1 ? '' : 's'} left`}</dd>
          </dl>
          {l.quota !== null ? (
            <div className="meter" role="meter" aria-label="Credits used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}>
              <span style={{ width: `${used}%`, background: used > 85 ? 'var(--down)' : undefined }} />
            </div>
          ) : null}
          <p className="small muted">Engine cycles you run cost 3 credits, analyst questions 1 and backtests 5. Reading the terminal is free.</p>
        </div>
      ) : null}
    </Card>
  );
}

function Appearance() {
  const [theme, toggle] = useTheme();
  return (
    <Card title="Appearance">
      <div className="field">
        <span className="field-label">Theme</span>
        <Segmented label="Theme" value={theme} onChange={(v) => v !== theme && toggle()} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        <span className="field-hint">Saved on this browser.</span>
      </div>
    </Card>
  );
}

function DeviceCard() {
  const sys = useQuery({ queryKey: keys.system, queryFn: () => api.get<{ process?: { rssBytes: number }; device?: { totalBytes: number; availableBytes: number }; vault?: { notes: number; bytes: number }; deploy?: { mode: string } }>('/api/system'), refetchInterval: 60_000 });
  const d = sys.data;
  return (
    <Card title="Server" meta="Where the engine, vault and memory run">
      {sys.isLoading ? (
        <LoadingRows rows={3} />
      ) : sys.isError ? (
        <ErrorState error={sys.error} onRetry={() => sys.refetch()} />
      ) : (
        <dl className="kv">
          <dt>Deployment</dt>
          <dd>{words(d?.deploy?.mode)}</dd>
          <dt>Process memory</dt>
          <dd>{bytes(d?.process?.rssBytes)}</dd>
          <dt>Device memory free</dt>
          <dd>{d?.device ? `${bytes(d.device.availableBytes)} of ${bytes(d.device.totalBytes)}` : '—'}</dd>
          <dt>Vault</dt>
          <dd>{d?.vault ? `${d.vault.notes} notes · ${bytes(d.vault.bytes)}` : '—'}</dd>
        </dl>
      )}
    </Card>
  );
}

function About() {
  return (
    <Card title="About">
      <div className="stack-sm small" style={{ color: 'var(--ink-2)' }}>
        <p>Lumina is analysis software, not financial advice. Leveraged trading can lose more than your deposit; test on paper or a demo account first.</p>
        <p>
          Charts are drawn with TradingView Lightweight Charts™, Copyright © 2025 TradingView, Inc.,{' '}
          <a className="link" href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
            tradingview.com
          </a>
          .
        </p>
      </div>
    </Card>
  );
}
