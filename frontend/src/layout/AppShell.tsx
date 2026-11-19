import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  BookOpen,
  Bot,
  CandlestickChart,
  FileStack,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Newspaper,
  NotebookPen,
  Radar,
  Settings,
  Sun,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useSession } from '../auth/session';
import { useLiveStream, useTerminal } from '../lib/queries';
import { money, signed, tone } from '../lib/format';
import { useTheme } from '../lib/theme';
import { Badge, Button, ConfirmDialog } from '../components/ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Trade',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/markets', label: 'Markets', icon: CandlestickChart },
      { to: '/positions', label: 'Positions', icon: Wallet },
      { to: '/signals', label: 'Signals', icon: Radar },
    ],
  },
  {
    label: 'Research',
    items: [
      { to: '/assistant', label: 'Analyst', icon: Bot },
      { to: '/journal', label: 'Journal', icon: NotebookPen },
      { to: '/backtest', label: 'Backtest', icon: FlaskConical },
      { to: '/vault', label: 'Vault', icon: BookOpen },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/news', label: 'News', icon: Newspaper },
      { to: '/files', label: 'Files', icon: FileStack },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const OWNER_ITEM: NavItem = { to: '/owner', label: 'Owner console', icon: KeyRound };

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/markets': 'Markets',
  '/positions': 'Positions',
  '/signals': 'Signals and scanner',
  '/assistant': 'Analyst',
  '/journal': 'Journal',
  '/backtest': 'Backtest',
  '/vault': 'Vault',
  '/news': 'News',
  '/files': 'Files',
  '/settings': 'Settings',
  '/owner': 'Owner console',
};

const MOBILE: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/markets', label: 'Markets', icon: CandlestickChart },
  { to: '/positions', label: 'Positions', icon: Wallet },
  { to: '/signals', label: 'Signals', icon: Radar },
  { to: '/assistant', label: 'Analyst', icon: Bot },
];

export function AppShell() {
  const session = useSession();
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const terminal = useTerminal();
  const stream = useLiveStream(session.active);
  const title = TITLES[pathname] ?? TITLES['/' + pathname.split('/')[1]] ?? 'Lumina';

  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    document.title = `${title} · Lumina`;
  }, [title]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const t = terminal.data;
  const ccy = t?.account.currency ?? 'USD';
  const groups = session.owner ? [...GROUPS.slice(0, 2), { ...GROUPS[2], items: [...GROUPS[2].items, OWNER_ITEM] }] : GROUPS;

  return (
    <div className="shell" data-nav-open={navOpen}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {navOpen ? <button type="button" className="nav-scrim" aria-label="Close menu" onClick={() => setNavOpen(false)} /> : null}
      <aside className="sidebar" id="app-nav" aria-label="Main">
        <NavLink to="/" className="brand" aria-label="Lumina, overview">
          <span className="mark" aria-hidden="true" style={{ color: 'var(--action)' }} />
          Lumina
        </NavLink>
        <nav className="stack" style={{ gap: 0 }}>
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <span className="nav-label">{g.label}</span>
              {g.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === '/'} className="nav-link">
                  <item.icon aria-hidden />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="card" style={{ padding: 'var(--s-3) var(--s-4)' }}>
            <div className="row-between small">
              <span className="muted">{session.owner ? 'Owner terminal' : 'Licence'}</span>
              <Badge tone={t?.live.mode === 'live' ? 'warn' : 'action'}>{t?.live.mode === 'live' ? 'Live' : 'Paper'}</Badge>
            </div>
            <div className="small" style={{ marginTop: 4 }}>
              {session.owner ? 'Unlimited quota' : licenceLine(t?.licence ?? session.status?.licence)}
            </div>
          </div>
          <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'nowrap' }}>
            <Button variant="ghost" size="sm" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'} style={{ flex: 1 }}>
              {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
              {theme === 'dark' ? 'Light' : 'Dark'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOut(true)} style={{ flex: 1 }}>
              <LogOut aria-hidden="true" /> Sign out
            </Button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" icon className="menu-toggle" aria-label="Open menu" aria-expanded={navOpen} aria-controls="app-nav" onClick={() => setNavOpen((v) => !v)}>
            <Menu aria-hidden="true" />
          </Button>
          <h1 className="topbar-title">{title}</h1>
          <div className="topbar-stats" aria-live="off">
            <div className="topbar-stat">
              <span>Equity</span>
              <span>{t ? money(t.account.equity, ccy) : '—'}</span>
            </div>
            <div className="topbar-stat secondary">
              <span>Today</span>
              <span className={tone(t?.account.dayPnl)}>{t ? signed(t.account.dayPnl) : '—'}</span>
            </div>
            <div className="topbar-stat optional">
              <span>Open P&amp;L</span>
              <span className={tone(t?.account.unrealised)}>{t ? signed(t.account.unrealised) : '—'}</span>
            </div>
            <span title={stream === 'live' ? 'Prices are streaming' : 'Reconnecting to the price stream'}>
              <Badge tone={stream === 'live' ? 'up' : 'warn'} dot>
                {stream === 'live' ? 'Streaming' : 'Reconnecting'}
              </Badge>
            </span>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <div key={pathname} className="page-enter stack" style={{ gap: 'var(--s-5)' }}>
            <Outlet />
          </div>
        </main>
      </div>

      <nav className="mobile-tabs" aria-label="Quick">
        {MOBILE.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.to === '/'}>
            <m.icon aria-hidden />
            {m.label}
          </NavLink>
        ))}
      </nav>

      <ConfirmDialog
        open={confirmOut}
        onClose={() => setConfirmOut(false)}
        title="Sign out of this device?"
        confirmLabel="Sign out"
        busy={signingOut}
        onConfirm={async () => {
          setSigningOut(true);
          try {
            await session.signOut();
          } finally {
            setSigningOut(false);
            setConfirmOut(false);
          }
        }}
      >
        {session.owner
          ? 'This ends the owner session on this browser. Open positions keep running on the server.'
          : 'You will need your licence key, or your access ID and code, to sign back in. Open positions keep running on the server.'}
      </ConfirmDialog>
    </div>
  );
}

function licenceLine(l: { plan: string; remaining: number | null; daysLeft: number | null } | null | undefined): string {
  if (!l) return '—';
  const parts = [l.plan.charAt(0).toUpperCase() + l.plan.slice(1)];
  if (l.remaining !== null) parts.push(`${l.remaining.toLocaleString('en-US')} credits`);
  if (l.daysLeft !== null) parts.push(`${l.daysLeft} days left`);
  return parts.join(' · ');
}
