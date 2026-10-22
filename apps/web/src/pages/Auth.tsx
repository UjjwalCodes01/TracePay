import { useMutation } from '@tanstack/react-query';
import { ShoppingBag, Users, Wallet, Wand2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Button, ErrorNote, useDocumentTitle } from '../components/ui';
import { useSession } from '../lib/session';

/** Where to go after signing in: the page that sent you here (a shared receipt, a PayPal return…), else your start page. */
function useReturnTo(): string {
  const from = (useLocation().state as { from?: unknown } | null)?.from;
  // Only paths inside the app: never "//elsewhere.example".
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login') ? from : '/';
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const { user } = useSession();
  const returnTo = useReturnTo();
  // Already signed in (or acting as a demo role): nothing to do here.
  if (user) return <Navigate to={returnTo} replace />;
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="flex items-center justify-center gap-2">
            <img src="/favicon.svg" alt="" className="size-8" />
            <span className="text-xl font-semibold tracking-tight">TracePay</span>
          </div>
          <p className="mx-auto mt-3 max-w-sm text-sm text-muted">
            Sell AI-made reports and answers you’re allowed to sell, take payment with PayPal, and pay every contributor their share automatically.
          </p>
        </div>
        <DemoShortcut />
        <div className="rounded-2xl border border-line bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** In demo mode, judges can skip accounts entirely and explore as a seeded role. */
function DemoShortcut() {
  const { config, users, switchUser, loading } = useSession();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  // The server may be waking up: hold the demo's place rather than hiding the main way in.
  if (!config && loading) {
    return (
      <div className="mb-6 rounded-2xl border border-line bg-white p-5" role="status">
        <div className="text-sm font-medium">Starting the demo…</div>
        <p className="mt-1 text-xs text-muted">The demo server sleeps when nobody is using it; waking it can take up to a minute.</p>
      </div>
    );
  }
  if (!config?.demoMode || users.length === 0) return null;
  const pick = (role: string) => users.find((u) => u.role === role);
  const roles = [
    { role: 'publisher', label: 'Report publisher', icon: Wand2 },
    { role: 'buyer', label: 'Buyer', icon: ShoppingBag },
    { role: 'contributor', label: 'Contributor', icon: Wallet },
  ];
  return (
    <div className="mb-6 rounded-2xl border-2 border-ink bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 font-semibold">
        <Users className="size-4" /> Try the demo — no account needed
      </div>
      <p className="mt-1 text-xs text-muted">Pick a role. Made-up data and PayPal test money; switch roles any time from the top bar.</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {roles.map(({ role, label, icon: Icon }) => {
          const u = pick(role);
          return (
            <button
              key={role}
              disabled={!u}
              onClick={async () => {
                if (!u) return;
                // Wait for the new role to load, or the app still sees "signed out" and bounces back here.
                await switchUser(u.id);
                navigate(returnTo);
              }}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-line px-2 py-3 text-xs font-medium hover:border-ink disabled:opacity-40"
            >
              <Icon className="size-5" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const input = 'h-11 w-full rounded-xl border border-line px-3 text-sm focus:border-ink focus:outline-none';

export function SignInPage() {
  useDocumentTitle('Sign in');
  const { signIn } = useSession();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation({ mutationFn: () => signIn(email, password), onSuccess: () => navigate(returnTo) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

  return (
    <AuthShell title="Sign in" subtitle="With your TracePay account.">
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Email</span>
          <input className={input} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Password</span>
          <input className={input} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorNote error={m.error} />
        <Button className="h-11 w-full" loading={m.isPending}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        New to TracePay?{' '}
        <Link to="/signup" className="font-medium text-ink underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}

const ROLES = [
  { value: 'publisher', title: 'I create reports', text: 'Build AI reports from licensed sources and sell them.' },
  { value: 'contributor', title: 'I license my work', text: 'Get paid when reports use your data or research.' },
  { value: 'buyer', title: 'I buy reports', text: 'Purchase reports built from properly licensed sources.' },
] as const;

export function SignUpPage() {
  useDocumentTitle('Create an account');
  const { signUp } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'publisher' as (typeof ROLES)[number]['value'], paypalEmail: '' });
  const m = useMutation({
    mutationFn: () => signUp({ ...form, paypalEmail: form.paypalEmail || undefined }),
    onSuccess: () => navigate('/'),
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <AuthShell title="Create your account" subtitle="Takes less than a minute.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="space-y-4"
      >
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium">What brings you here?</legend>
          {ROLES.map((r) => (
            <label key={r.value} className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${form.role === r.value ? 'border-ink bg-slate-50' : 'border-line'}`}>
              <input type="radio" name="role" className="mt-0.5" checked={form.role === r.value} onChange={() => set('role', r.value)} />
              <span>
                <span className="block font-medium">{r.title}</span>
                <span className="text-muted">{r.text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">{form.role === 'publisher' ? 'Studio or company name' : 'Your name'}</span>
          <input className={input} required minLength={2} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Email</span>
          <input className={input} type="email" autoComplete="email" required value={form.email} onChange={(e) => set('email', e.target.value)} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Password</span>
          <input className={input} type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={(e) => set('password', e.target.value)} />
          <span className="text-xs text-muted">At least 10 characters.</span>
        </label>
        {form.role === 'contributor' && (
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">PayPal email for payments</span>
            <input className={input} type="email" value={form.paypalEmail} onChange={(e) => set('paypalEmail', e.target.value)} />
            <span className="text-xs text-muted">Where your share of each sale is sent. You can add it later.</span>
          </label>
        )}
        <ErrorNote error={m.error} />
        <p className="text-xs text-muted">
          By creating an account you agree to the{' '}
          <Link to="/terms" className="underline hover:text-ink">Terms</Link> and how we handle data in the{' '}
          <Link to="/privacy" className="underline hover:text-ink">Privacy</Link> page.
        </p>
        <Button className="h-11 w-full" loading={m.isPending}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-ink underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
