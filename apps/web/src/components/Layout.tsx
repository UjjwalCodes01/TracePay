import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BookOpenCheck, Bot, ChevronDown, Code2, Coins, Database, FileStack, LayoutDashboard, Library, LogOut, MessageSquareQuote, Receipt, RotateCcw, ShoppingBag, Sparkles, UserRound, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { post } from '../lib/api';
import { useSession } from '../lib/session';
import type { DemoUser, Role } from '../lib/types';
import { Badge, Button, Card, ErrorNote, Spinner } from './ui';

const NAV: Array<{ to: string; label: string; icon: typeof LayoutDashboard; roles: Role[] }> = [
  { to: '/dashboard', label: 'Home', icon: LayoutDashboard, roles: ['publisher', 'admin'] },
  { to: '/registry', label: 'Sources & licenses', icon: Library, roles: ['publisher', 'admin'] },
  { to: '/studio', label: 'Create a report', icon: Bot, roles: ['publisher'] },
  { to: '/reports', label: 'My reports', icon: FileStack, roles: ['publisher', 'admin'] },
  { to: '/settlements', label: 'Pay contributors', icon: Receipt, roles: ['publisher', 'admin'] },
  { to: '/royalties', label: 'Answer royalties', icon: Coins, roles: ['publisher'] },
  { to: '/store', label: 'Report store', icon: ShoppingBag, roles: ['buyer'] },
  { to: '/ask', label: 'Ask the library', icon: MessageSquareQuote, roles: ['buyer'] },
  { to: '/assistant', label: 'Shopping assistant', icon: Sparkles, roles: ['buyer'] },
  { to: '/sources', label: 'My sources', icon: Database, roles: ['contributor'] },
  { to: '/earnings', label: 'My earnings', icon: Wallet, roles: ['contributor'] },
  { to: '/developers', label: 'Developers', icon: Code2, roles: ['publisher', 'admin'] },
  { to: '/developers', label: 'Connect an AI agent', icon: Code2, roles: ['buyer'] },
  { to: '/profile', label: 'Profile', icon: UserRound, roles: ['publisher', 'contributor', 'buyer', 'admin'] },
];

const ALL_ROLES: Role[] = ['publisher', 'contributor', 'buyer', 'admin'];
const PUBLISHING: Role[] = ['publisher', 'admin'];

/** Which roles may open a page; the first matching pattern wins. Anything else sends you to your start page. */
const PAGE_ROLES: Array<[RegExp, Role[]]> = [
  [/^\/reports\/[^/]+(\/(receipt|provenance))?\/?$/, ALL_ROLES],
  [/^\/developers(\/|$)/, ['publisher', 'admin', 'buyer']],
  [/^\/(reports|dashboard|registry|settlements)(\/|$)/, PUBLISHING],
  [/^\/studio(\/|$)/, ['publisher']],
  [/^\/assistant(\/|$)/, ['buyer']],
  [/^\/ask(\/|$)/, ['buyer']],
  [/^\/royalties(\/|$)/, ['publisher']],
  [/^\/(sources|earnings)(\/|$)/, ['contributor']],
];

export function allowedOn(path: string, role: Role): boolean {
  const rule = PAGE_ROLES.find(([pattern]) => pattern.test(path));
  return !rule || rule[1].includes(role);
}

const ROLE_LABEL: Record<Role, string> = { publisher: 'Publisher', buyer: 'Buyer', contributor: 'Contributor', admin: 'Admin' };

export function Layout() {
  const { user, authMethod, loading, error, retry, users, config, switchUser, signOut } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: () => post('/demo/reset'),
    onSuccess: () => qc.invalidateQueries(),
  });
  const [actionError, setActionError] = useState<unknown>(null);
  const location = useLocation();

  if (loading) return <WakingSpinner />;
  if (!user && error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <Card title="We couldn’t reach TracePay">
          <ErrorNote error={error} />
          <Button className="mt-4" onClick={retry}>
            Try again
          </Button>
        </Card>
      </div>
    );
  }
  // Back where they were going after signing in (a shared receipt link, a PayPal return…).
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  if (!allowedOn(pathname, user.role)) return <Navigate to="/" replace />;

  return (
    <div className="flex min-h-full">
      <a href="#main" className="sr-only z-50 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-white md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div>
            <div className="font-semibold tracking-tight">TracePay</div>
            <div className="text-[11px] text-muted">Sell AI reports fairly</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.filter((n) => user && n.roles.includes(user.role)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                clsx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:bg-slate-50 hover:text-ink')
              }
            >
              <n.icon className="size-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t border-line p-4 text-xs text-muted">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="info">PayPal test mode</Badge>
            {config && (config.generation === 'vertex' ? <Badge tone="ai">AI: Gemini</Badge> : <Badge tone="warn">AI: demo mode</Badge>)}
          </div>
          <p className="flex items-start gap-1.5">
            <BookOpenCheck className="mt-0.5 size-3.5 shrink-0" />
            {config?.demoMode ? 'Demo with made-up data. ' : ''}TracePay follows the license terms on record; it isn’t legal advice.
          </p>
          <p className="flex gap-2">
            <NavLink to="/privacy" className="underline hover:text-ink">Privacy</NavLink>
            <NavLink to="/terms" className="underline hover:text-ink">Terms</NavLink>
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-white/90 px-4 backdrop-blur md:px-8">
          <div className="flex shrink-0 items-center gap-2 md:hidden">
            <img src="/favicon.svg" alt="" className="size-6" />
            <span className="font-semibold">TracePay</span>
          </div>
          <div className="hidden min-w-0 truncate text-sm text-muted md:block">
            {authMethod === 'demo' && config?.demoMode ? 'Demo with made-up data and PayPal test money' : `Signed in as ${user.name}`}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {authMethod === 'demo' && config?.demoMode && (
              <RoleMenu
                current={user}
                users={users}
                onPick={(id) =>
                  // Start the new role on its own start page, once the switch has loaded.
                  void switchUser(id).then(
                    () => navigate('/'),
                    (e) => setActionError(e),
                  )
                }
              />
            )}
            {config?.demoMode && authMethod === 'demo' && (user.role === 'publisher' || user.role === 'admin') && (
              <Button
                variant="ghost"
                size="sm"
                loading={reset.isPending}
                onClick={() => confirm('Reset TracePay demo data? PayPal sandbox history is not affected.') && reset.mutate()}
                title="Restore demo fixtures"
              >
                <RotateCcw className="size-3.5" />
                <span className="hidden sm:inline">Reset demo</span>
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => signOut().then(() => navigate('/login'), (e) => setActionError(e))} title="Sign out">
              <LogOut className="size-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        {/* Mobile nav: the current page is scrolled into view; the fade says there's more. */}
        <MobileNav items={NAV.filter((n) => user && n.roles.includes(user.role))} pathname={pathname} />

        {(reset.error != null || actionError != null) && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 md:px-8">
            <div className="flex items-start justify-between gap-3">
              <ErrorNote error={reset.error ?? actionError} />
              <Button variant="ghost" size="sm" onClick={() => (reset.reset(), setActionError(null))}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** The first load can wait on a sleeping free-tier server: say so instead of spinning silently. */
function WakingSpinner() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Spinner label={slow ? 'Starting the demo server. It sleeps when nobody is using it and can take up to a minute to wake…' : 'Loading…'} />
    </div>
  );
}

/** Demo role picker: switches only on an explicit choice (a <select> switches on every arrow key on Windows). */
function RoleMenu({ current, users, onPick }: { current: DemoUser; users: DemoUser[]; onPick: (id: string) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details ref={ref} className="relative min-w-0">
      <summary
        className="flex h-8 min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-sm text-ink hover:bg-slate-50 [&::-webkit-details-marker]:hidden"
      >
        <span className="sr-only">Switch role. Current: </span>
        <span className="hidden text-xs text-muted sm:inline">Demo role</span>
        <span className="truncate font-medium">{ROLE_LABEL[current.role]}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
      </summary>
      <div role="menu" className="absolute right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-white p-1 shadow-lg">
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            role="menuitemradio"
            aria-checked={u.id === current.id}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              if (u.id !== current.id) onPick(u.id);
            }}
            className={clsx('flex w-full flex-col items-start rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50', u.id === current.id && 'bg-slate-100')}
          >
            <span className="font-medium">{ROLE_LABEL[u.role]}</span>
            <span className="text-xs text-muted">{u.name}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

function MobileNav({ items, pathname }: { items: typeof NAV; pathname: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname]);
  return (
    <div className="relative md:hidden">
      <nav ref={ref} aria-label="Pages" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-3 py-2 pr-8">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => clsx('whitespace-nowrap rounded-md px-3 py-1.5 text-sm', isActive ? 'bg-slate-100 font-medium' : 'text-muted')}>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white" />
    </div>
  );
}
