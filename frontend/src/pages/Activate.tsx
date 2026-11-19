import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Check } from 'lucide-react';
import { api, errorText, ApiError } from '../lib/api';
import { useSession } from '../auth/session';
import { Button, Field, Notice, Segmented, fieldProps } from '../components/ui';
import { ago } from '../lib/format';

type Mode = 'key' | 'login' | 'owner';

interface Health {
  ok: boolean;
  engine: { running: boolean; cycle: number };
  market: { calls: number; failures: number; lastSuccess: number | null; venues: Record<string, { ok: boolean; at: number; message: string }> };
}

/** What the browser tells about itself, for the owner's activation record. */
function deviceHints() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return { name: `${os} ${browser}`.trim(), os, browser };
}

export function Activate() {
  const session = useSession();
  const [mode, setMode] = useState<Mode>('key');
  const [handoff, setHandoff] = useState<{ id: string; code: string } | null>(null);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/api/health'),
    refetchInterval: 30_000,
    retry: 0,
  });

  if (handoff) return <Handoff login={handoff} onDone={() => session.refresh()} />;

  return (
    <div className="auth">
      <section className="auth-side" aria-label="About Lumina">
        <div>
          <span className="brand">
            <span className="mark" aria-hidden="true" style={{ color: '#3fb3bf' }} />
            Lumina
          </span>
        </div>
        <div>
          <h1>A trading terminal that sizes every order from its stop.</h1>
          <p>Signals come with the factors that scored them and the price that proves them wrong. Paper trading is the default; a live MT5 account trades only when the owner switches it on.</p>
        </div>
        <ServerPanel health={health.data} failed={health.isError} />
        <div className="auth-facts">
          <div>
            <strong>5</strong>
            <span>playbooks, each gated by market regime</span>
          </div>
          <div>
            <strong>0.5%</strong>
            <span>default equity at risk per trade</span>
          </div>
          <div>
            <strong>Paper</strong>
            <span>until live is enabled on the server</span>
          </div>
        </div>
      </section>

      <main className="auth-main" id="main">
        <div className="auth-panel">
          <header>
            <h2 style={{ fontSize: 24 }}>{mode === 'owner' ? 'Owner sign-in' : 'Activate this device'}</h2>
            <p>
              {mode === 'key'
                ? 'Enter the licence key you were given. It is stored as a secure cookie on this browser only.'
                : mode === 'login'
                  ? 'Already activated on another device? Use the access ID and code shown there.'
                  : 'The owner passphrase opens the owner console and an unlimited terminal.'}
            </p>
          </header>

          <Segmented
            label="Sign-in method"
            className="block"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'key', label: 'Licence key' },
              { value: 'login', label: 'Access code' },
              { value: 'owner', label: 'Owner' },
            ]}
          />

          {health.isError ? (
            <Notice kind="error" title="The server is not reachable">
              Sign-in needs the Lumina backend. Check that it is running, then try again.
            </Notice>
          ) : null}

          {mode === 'key' ? <KeyForm onDone={(login) => setHandoff(login)} /> : mode === 'login' ? <LoginForm onDone={() => session.refresh()} /> : <OwnerForm onDone={() => session.refresh()} />}

          <p className="small muted">No key yet? Ask the owner of this Lumina server for one. Licence keys look like LV-XXXXX-XXXXX-XXXXX-XXXXX.</p>
        </div>
      </main>
    </div>
  );
}

function ServerPanel({ health, failed }: { health?: Health; failed: boolean }) {
  const venues = Object.entries(health?.market.venues ?? {});
  return (
    <div className="auth-visual" aria-label="Server status" role="group">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <span>Server</span>
        <span className="num">{failed ? 'unreachable' : !health ? 'checking…' : health.engine.running ? `engine running · cycle ${health.engine.cycle}` : 'engine paused'}</span>
      </div>
      <div className="stack-sm">
        {venues.length ? (
          venues.map(([name, v]) => (
            <div key={name} className="row-between">
              <span style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{name}</span>
              <span className="num" style={{ color: v.ok ? '#45c98a' : '#ff8a7d' }}>
                {v.ok ? `prices ok · ${ago(v.at)}` : 'unavailable'}
              </span>
            </div>
          ))
        ) : (
          <div className="row-between">
            <span>Market data</span>
            <span className="num">{failed ? '—' : 'warming up'}</span>
          </div>
        )}
        <div className="row-between">
          <span>Requests to venues</span>
          <span className="num">{health ? `${health.market.calls} · ${health.market.failures} failed` : '—'}</span>
        </div>
      </div>
    </div>
  );
}

const KEY_RE = /^LV-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/;
const TOKEN_RE = /^LV1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function normaliseKey(raw: string): string {
  const t = raw.trim();
  if (TOKEN_RE.test(t)) return t;
  const body = t.toUpperCase().replace(/^LV-?/, '').replace(/[^A-Z0-9]/g, '');
  return body.length === 20 ? `LV-${body.match(/.{5}/g)!.join('-')}` : t.toUpperCase();
}

function KeyForm({ onDone }: { onDone: (login: { id: string; code: string }) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const k = normaliseKey(key);
    if (!KEY_RE.test(k) && !TOKEN_RE.test(k)) {
      setError('Write the key as LV- followed by four groups of five letters or digits.');
      document.getElementById('lic-key')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ login: { id: string; code: string } }>('/api/licence/activate', { key: k, device: deviceHints() });
      onDone(r.login);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={submit} noValidate>
      <Field label="Licence key" htmlFor="lic-key" error={error} hint="Dashes and lower case are fine.">
        <input
          className="input num"
          {...fieldProps('lic-key', error, true)}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="LV-XXXXX-XXXXX-XXXXX-XXXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" block go busy={busy}>
        Activate device
      </Button>
    </form>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ id?: string; code?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    const cleanId = id.trim().toUpperCase();
    const cleanCode = code.trim().toUpperCase().replace(/\s+/g, '');
    if (!/^(LV-)?[A-F0-9]{16}$/.test(cleanId)) next.id = 'The access ID is LV- followed by 16 letters A–F and digits.';
    if (!/^[A-F0-9]{16}$/.test(cleanCode)) next.code = 'The access code is 16 letters A–F and digits.';
    setErrors(next);
    if (next.id || next.code) {
      document.getElementById(next.id ? 'acc-id' : 'acc-code')?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/login', { id: cleanId, code: cleanCode });
      onDone();
    } catch (err) {
      setErrors({ form: err instanceof ApiError && err.code === 'LOGIN_INVALID' ? 'That access ID and code do not match. Check both and try again.' : errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={submit} noValidate>
      <Field label="Access ID" htmlFor="acc-id" error={errors.id}>
        <input className="input num" {...fieldProps('acc-id', errors.id)} value={id} onChange={(e) => setId(e.target.value)} placeholder="LV-0123456789ABCDEF" autoComplete="username" spellCheck={false} />
      </Field>
      <Field label="Access code" htmlFor="acc-code" error={errors.code}>
        <input className="input num" {...fieldProps('acc-code', errors.code)} value={code} onChange={(e) => setCode(e.target.value)} type="password" autoComplete="current-password" spellCheck={false} />
      </Field>
      {errors.form ? <Notice kind="error">{errors.form}</Notice> : null}
      <Button type="submit" variant="primary" size="lg" block go busy={busy}>
        Sign in
      </Button>
    </form>
  );
}

function OwnerForm({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pass) {
      setError('Write the owner passphrase.');
      document.getElementById('owner-pass')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/owner/login', { passphrase: pass });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That passphrase is not right, or the owner panel is disabled on this server.' : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={submit} noValidate>
      <Field label="Owner passphrase" htmlFor="owner-pass" error={error}>
        <input className="input" type="password" {...fieldProps('owner-pass', error)} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
      </Field>
      <Button type="submit" variant="primary" size="lg" block go busy={busy}>
        Open owner terminal
      </Button>
    </form>
  );
}

/** After activation: the one moment the access code for a second device is shown. */
function Handoff({ login, onDone }: { login: { id: string; code: string }; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    document.getElementById('handoff-continue')?.focus();
  }, []);
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="auth-main" style={{ minHeight: '100dvh' }}>
      <main className="auth-panel" id="main">
        <header>
          <h1 style={{ fontSize: 24 }}>This device is active</h1>
          <p>Keep this access ID and code to sign in on a second device without your licence key. The code is shown only now.</p>
        </header>
        <div className="stack-sm">
          <span className="field-label">Access ID</span>
          <div className="keybox">
            <span>{login.id}</span>
            <Button variant="ghost" icon size="sm" onClick={() => copy('id', login.id)} aria-label="Copy access ID">
              {copied === 'id' ? <Check /> : <Copy />}
            </Button>
          </div>
        </div>
        <div className="stack-sm">
          <span className="field-label">Access code</span>
          <div className="keybox">
            <span>{login.code}</span>
            <Button variant="ghost" icon size="sm" onClick={() => copy('code', login.code)} aria-label="Copy access code">
              {copied === 'code' ? <Check /> : <Copy />}
            </Button>
          </div>
        </div>
        <p role="status" className="small muted" style={{ minHeight: 20 }}>
          {copied ? `${copied === 'id' ? 'Access ID' : 'Access code'} copied.` : ''}
        </p>
        <Button id="handoff-continue" variant="primary" size="lg" block go onClick={onDone}>
          Open the terminal
        </Button>
      </main>
    </div>
  );
}
