import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, RefreshCw, X, XCircle, type LucideIcon } from 'lucide-react';
import { errorText } from '../lib/api';
import { tone } from '../lib/format';

/* ---------------------------------------------------------------- button */

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'buy' | 'sell';
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  icon?: boolean;
  /** The drawn arrow of the dealt "arrow" button look; for actions that move forward. */
  go?: boolean;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'secondary', size = 'md', block, icon, go, busy, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = [
    'btn',
    variant !== 'secondary' && `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    block && 'btn--block',
    icon && 'btn--icon',
    go && !busy && 'btn--go',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});

/* ---------------------------------------------------------------- card */

export function Card({ title, meta, actions, children, className = '', bodyClass = '', as: As = 'section', id }: { title?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; as?: 'section' | 'div' | 'article'; id?: string }) {
  const hid = useId();
  return (
    <As className={`card ${className}`} aria-labelledby={title ? hid : undefined} id={id}>
      {title || actions ? (
        <header className="card-head">
          <div className="stack-sm" style={{ gap: 0 }}>
            {title ? <h2 id={hid}>{title}</h2> : null}
            {meta ? <span className="meta">{meta}</span> : null}
          </div>
          {actions ? <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'nowrap' }}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={`card-body ${bodyClass}`}>{children}</div>
    </As>
  );
}

/* ---------------------------------------------------------------- badges */

export function Badge({ tone: t, children, dot }: { tone?: 'up' | 'down' | 'action' | 'warn' | ''; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge ${t ? `badge--${t}` : ''}`}>
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function SideBadge({ side }: { side: string | null | undefined }) {
  const long = side === 'long' || side === 'buy';
  if (!side) return <span className="muted">—</span>;
  return <Badge tone={long ? 'up' : 'down'}>{long ? (side === 'buy' ? 'Buy' : 'Long') : side === 'sell' ? 'Sell' : 'Short'}</Badge>;
}

/** A profit or loss number in its colour, with the sign spelled out for screen readers. */
export function PnL({ value, children }: { value: number | null | undefined; children: ReactNode }) {
  const t = tone(value);
  return (
    <span className={`num ${t}`}>
      {t ? <span className="visually-hidden">{t === 'up' ? 'profit ' : 'loss '}</span> : null}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- states */

export function Empty({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {Icon ? <Icon aria-hidden /> : null}
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'This could not be loaded' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="empty" role="alert">
      <XCircle aria-hidden="true" style={{ color: 'var(--down)' }} />
      <strong>{title}</strong>
      <p>{errorText(error)}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" /> Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden="true" />;
}

export function LoadingRows({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="stack" aria-busy="true" aria-label={label} style={{ padding: 'var(--s-5)' }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={18} w={`${92 - i * 9}%`} />
      ))}
    </div>
  );
}

export function Notice({ kind = 'info', title, children, action }: { kind?: 'info' | 'warn' | 'error' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = { info: Info, warn: AlertTriangle, error: XCircle, ok: CheckCircle2 }[kind];
  return (
    <div className={`notice notice--${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon aria-hidden="true" />
      <div className="notice-body" style={{ flex: 1 }}>
        {title ? <strong>{title}</strong> : null}
        {children ? <span>{children}</span> : null}
      </div>
      {action}
    </div>
  );
}

/* ---------------------------------------------------------------- fields */

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span className="field-error" id={`${htmlFor}-error`}>
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** aria wiring for an input inside <Field>. */
export function fieldProps(id: string, error?: string | null, hint?: boolean) {
  return {
    id,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
  };
}

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; id?: string }) {
  const gen = useId();
  const sid = id ?? gen;
  return (
    <label className="check" htmlFor={sid}>
      <input id={sid} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label, className = '' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; side?: string }[]; label: string; className?: string }) {
  return (
    <div className={`segmented ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-side={o.side}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const i = options.findIndex((x) => x.value === value);
            const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
            onChange(next.value);
            const parent = e.currentTarget.parentElement;
            requestAnimationFrame(() => parent?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
          }}
          tabIndex={o.value === value ? 0 : -1}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- stat */

export function Stat({ label, value, sub, valueClass = '' }: { label: ReactNode; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${valueClass}`}>{value}</span>
      {sub !== undefined ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- dialog */

/**
 * A native <dialog>: focus is trapped, Escape closes, and focus returns to the
 * control that opened it, without a library.
 */
export function Dialog({ open, onClose, title, description, children, footer, wide }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const hid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={hid}
      style={wide ? { width: 'min(720px, calc(100vw - 32px))' } : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <>
          <div className="dialog-head">
            <div>
              <h2 id={hid}>{title}</h2>
              {description ? <p>{description}</p> : null}
            </div>
            <Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Close dialog">
              <X />
            </Button>
          </div>
          {children ? <div className="dialog-body">{children}</div> : <div style={{ height: 'var(--s-5)' }} />}
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, busy, danger }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; children?: ReactNode; confirmLabel: string; busy?: boolean; danger?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ? <div className="small" style={{ color: 'var(--ink-2)' }}>{children}</div> : null}
    </Dialog>
  );
}
