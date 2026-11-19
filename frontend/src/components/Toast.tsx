import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  title: string;
  detail?: string;
}

interface ToastApi {
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: Kind, title: string, detail?: string) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, kind, title, detail }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, d) => push('success', t, d),
      error: (t, d) => push('error', t, d),
      info: (t, d) => push('info', t, d),
    }),
    [push],
  );

  const Icon = { success: CheckCircle2, error: XCircle, info: Info };

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {items.map((t) => {
          const I = Icon[t.kind];
          return (
            <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
              <I aria-hidden="true" />
              <div className="toast-body">
                <strong>{t.title}</strong>
                {t.detail ? <span>{t.detail}</span> : null}
              </div>
              <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                <X />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const t = useContext(Ctx);
  if (!t) throw new Error('useToast outside ToastProvider');
  return t;
}
