import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './auth/session';
import { AppShell } from './layout/AppShell';
import { Activate } from './pages/Activate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Button, LoadingRows } from './components/ui';

// Each screen is its own chunk; the overview and markets are the hot path.
const page = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) => lazy(() => load().then((m) => ({ default: m[name] as React.ComponentType })));
const Dashboard = page(() => import('./pages/Dashboard'), 'Dashboard');
const Markets = page(() => import('./pages/Markets'), 'Markets');
const Positions = page(() => import('./pages/Positions'), 'Positions');
const Signals = page(() => import('./pages/Signals'), 'Signals');
const Assistant = page(() => import('./pages/Assistant'), 'Assistant');
const Journal = page(() => import('./pages/Journal'), 'Journal');
const Backtest = page(() => import('./pages/Backtest'), 'Backtest');
const Vault = page(() => import('./pages/Vault'), 'Vault');
const Files = page(() => import('./pages/Files'), 'Files');
const News = page(() => import('./pages/News'), 'News');
const Settings = page(() => import('./pages/Settings'), 'Settings');
const Owner = page(() => import('./pages/Owner'), 'Owner');
const NotFound = page(() => import('./pages/NotFound'), 'NotFound');

function Screen({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname}>
      <Suspense fallback={<LoadingRows rows={6} label="Loading the screen" />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function OwnerOnly({ children }: { children: ReactNode }) {
  const { owner } = useSession();
  return owner ? <>{children}</> : <Navigate to="/" replace />;
}

function Gate() {
  const session = useSession();
  if (session.loading) {
    return (
      <div className="auth-main" style={{ minHeight: '100dvh' }} aria-busy="true">
        <span className="brand" style={{ fontSize: 22 }}>
          <span className="mark" aria-hidden="true" style={{ color: 'var(--action)' }} />
          Lumina
        </span>
      </div>
    );
  }
  if (session.error && !session.status) {
    return (
      <div className="auth-main" style={{ minHeight: '100dvh' }}>
        <div className="auth-panel" role="alert">
          <h1 style={{ fontSize: 24 }}>The Lumina server is not reachable</h1>
          <p className="muted">{session.error.message}</p>
          <Button variant="primary" onClick={() => session.refresh()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!session.active) return <Activate />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Screen><Dashboard /></Screen>} />
        <Route path="markets" element={<Screen><Markets /></Screen>} />
        <Route path="positions" element={<Screen><Positions /></Screen>} />
        <Route path="signals" element={<Screen><Signals /></Screen>} />
        <Route path="assistant" element={<Screen><Assistant /></Screen>} />
        <Route path="journal" element={<Screen><Journal /></Screen>} />
        <Route path="backtest" element={<Screen><Backtest /></Screen>} />
        <Route path="vault" element={<Screen><Vault /></Screen>} />
        <Route path="files" element={<Screen><Files /></Screen>} />
        <Route path="news" element={<Screen><News /></Screen>} />
        <Route path="settings" element={<Screen><Settings /></Screen>} />
        <Route path="owner" element={<OwnerOnly><Screen><Owner /></Screen></OwnerOnly>} />
        <Route path="*" element={<Screen><NotFound /></Screen>} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Gate />
    </BrowserRouter>
  );
}
