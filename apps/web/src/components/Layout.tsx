import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BookOpenCheck, Bot, FileStack, LayoutDashboard, Library, Receipt, RotateCcw, ShoppingBag, Wallet } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { post } from '../lib/api';
import { useSession } from '../lib/session';
import type { Role } from '../lib/types';
import { Badge, Button } from './ui';

const NAV: Array<{ to: string; label: string; icon: typeof LayoutDashboard; roles: Role[] }> = [
  { to: '/dashboard', label: 'Home', icon: LayoutDashboard, roles: ['publisher', 'admin'] },
  { to: '/registry', label: 'Sources & Licenses', icon: Library, roles: ['publisher', 'admin'] },
  { to: '/studio', label: 'Create a Report', icon: Bot, roles: ['publisher'] },
  { to: '/reports', label: 'My Reports', icon: FileStack, roles: ['publisher', 'admin'] },
  { to: '/settlements', label: 'Pay Contributors', icon: Receipt, roles: ['publisher', 'admin'] },
  { to: '/store', label: 'Report Store', icon: ShoppingBag, roles: ['buyer'] },
  { to: '/earnings', label: 'My Earnings', icon: Wallet, roles: ['contributor'] },
];

const ROLE_LABEL: Record<Role, string> = { publisher: 'Publisher', buyer: 'Buyer', contributor: 'Contributor', admin: 'Admin' };

export function Layout() {
  const { user, users, config, switchUser } = useSession();
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: () => post('/demo/reset'),
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <div className="flex min-h-full">
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
            Demo with made-up data. TracePay follows the license terms on record; it isn’t legal advice.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-white/90 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-2 md:hidden">
            <img src="/favicon.svg" alt="" className="size-6" />
            <span className="font-semibold">TracePay</span>
          </div>
          <div className="hidden text-sm text-muted md:block">{user ? `Acting as ${user.name}` : 'Choose a demo user'}</div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              <span className="hidden sm:inline">Demo role</span>
              <select
                value={user?.id ?? ''}
                onChange={(e) => switchUser(e.target.value)}
                className="h-8 max-w-[14rem] rounded-lg border border-line bg-white px-2 text-sm text-ink"
                aria-label="Switch demo user"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {ROLE_LABEL[u.role]} — {u.name}
                  </option>
                ))}
              </select>
            </label>
            {(user?.role === 'publisher' || user?.role === 'admin') && (
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
          </div>
        </header>

        {/* Mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b border-line bg-white px-3 py-2 md:hidden">
          {NAV.filter((n) => user && n.roles.includes(user.role)).map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => clsx('whitespace-nowrap rounded-md px-3 py-1.5 text-sm', isActive ? 'bg-slate-100 font-medium' : 'text-muted')}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
