import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertCircle, ArrowRight, CheckCircle2, Circle, Clock, FileText, HandCoins, MessageSquareQuote, PartyPopper, ShieldCheck, ShoppingCart, Users, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { NeedsAttention } from '../components/NeedsAttention';
import { ErrorNote, Hash, Spinner, useDocumentTitle } from '../components/ui';
import { describeEvent, type ActivityTone } from '../lib/activity';
import { api } from '../lib/api';
import { eventLabel, formatMoney, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';
import type { Dashboard } from '../lib/types';

interface NextStep {
  tone: 'action' | 'attention' | 'waiting' | 'done';
  title: string;
  text: string;
  cta?: { to: string; label: string };
}

function nextStep(d: Dashboard, openIssues: number): NextStep {
  // Open reconciliation issues are what still needs a person. A settlement stays marked as an
  // exception after a refund even once it's been handled, so that count alone mustn't block the next steps.
  if (openIssues > 0)
    return {
      tone: 'attention',
      title: openIssues === 1 ? 'One thing needs your attention' : `${openIssues} things need your attention`,
      text: 'TracePay checked your payments with PayPal and found something a person should look at. It’s explained just below.',
    };
  if (d.licenseOffers > 0)
    return { tone: 'action', title: d.licenseOffers === 1 ? 'A contributor offered you a license' : `${d.licenseOffers} license offers are waiting`, text: 'Review the terms in plain language. Nothing applies until you accept.', cta: { to: '/registry?tab=offers', label: 'Review offers' } };
  if (d.agentWaiting > 0)
    return { tone: 'action', title: 'Your assistant is waiting for your OK', text: 'One of your sources can’t be used for a paid report. The assistant found a replacement and needs you to approve it.', cta: { to: '/studio', label: 'Review the suggestion' } };
  if (d.settlementsToApprove > 0)
    return { tone: 'action', title: 'You made a sale! Approve the contributor payments', text: 'TracePay has worked out what each contributor is owed under their agreement. Check it and approve.', cta: { to: '/settlements', label: 'Review payments' } };
  if (d.settlementsToPay > 0)
    return { tone: 'action', title: 'Send the approved payments', text: 'One click sends every contributor their share through PayPal.', cta: { to: '/settlements', label: 'Pay contributors' } };
  if (d.payoutsInProgress > 0)
    return { tone: 'waiting', title: 'Payments are on their way', text: 'PayPal is delivering the contributor payments. Check back to confirm everyone received their money.', cta: { to: '/settlements', label: 'Check status' } };
  if (d.artifacts === 0)
    return { tone: 'action', title: 'Create your first report', text: 'Pick the sources you’ve licensed and describe the report. TracePay checks you’re allowed to sell it before anything is written.', cta: { to: '/studio', label: 'Create a report' } };
  if (d.verifiedSales === 0)
    return { tone: 'waiting', title: 'Your report is ready to sell', text: 'It’s listed in the store, waiting for a buyer to pay with PayPal.', cta: d.latestArtifact ? { to: `/reports/${d.latestArtifact.id}`, label: 'View the report' } : undefined };
  return { tone: 'done', title: 'All caught up', text: 'Every contributor has been paid for every sale.', cta: { to: '/studio', label: 'Create another report' } };
}

const NEXT_STYLE = {
  action: { box: 'border-ink bg-ink text-white', icon: <ArrowRight className="size-6" />, sub: 'text-slate-300', btn: 'bg-white text-ink hover:bg-slate-100' },
  attention: { box: 'border-red-200 bg-red-50 text-block', icon: <AlertCircle className="size-6" />, sub: 'text-red-800/80', btn: 'bg-block text-white hover:bg-red-800' },
  waiting: { box: 'border-amber-200 bg-amber-50 text-amber-900', icon: <Clock className="size-6" />, sub: 'text-amber-900/80', btn: 'bg-amber-900 text-white hover:bg-amber-950' },
  done: { box: 'border-green-200 bg-green-50 text-verified', icon: <PartyPopper className="size-6" />, sub: 'text-green-900/80', btn: 'bg-verified text-white hover:bg-green-800' },
} as const;

const TONE_ICON: Record<ActivityTone, ReactNode> = {
  good: <CheckCircle2 className="size-4 text-pass" />,
  bad: <AlertCircle className="size-4 text-block" />,
  waiting: <Clock className="size-4 text-amber-600" />,
  neutral: <Circle className="size-4 text-slate-300" />,
};

export function DashboardPage() {
  const { user, authMethod, config } = useSession();
  const [technical, setTechnical] = useState(false);
  // Every 15 s is plenty for a summary page (and lets an idle database sleep sooner).
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard'), refetchInterval: 15_000 });
  const chain = useQuery({ queryKey: ['chain'], queryFn: () => api<{ ok: boolean; length?: number; brokenAtSeq?: number }>('/audit/verify-chain'), enabled: technical });
  const isPublisher = user?.role === 'publisher' || user?.role === 'admin';
  // Shared with the "Needs attention" panel (same query key: fetched once).
  const recon = useQuery({ queryKey: ['reconciliation'], queryFn: () => api<{ open_issues: number }>('/v1/reconciliation'), refetchInterval: 30_000, enabled: isPublisher });
  // Pay-per-citation: answers from this library and what their authors are owed (publishers only).
  const royalties = useQuery({
    queryKey: ['royalties'],
    queryFn: () => api<{ answers: number; accrued: Array<{ amountCents: number }> }>('/royalties'),
    enabled: user?.role === 'publisher',
  });
  useDocumentTitle('Home');

  if (q.error && !q.data) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  const demo = authMethod === 'demo' && !!config?.demoMode;
  const next = nextStep(d, recon.data?.open_issues ?? 0);
  const style = NEXT_STYLE[next.tone];

  const journey = [
    { icon: ShieldCheck, title: 'Check your sources', text: 'Make sure you’re allowed to sell what you make', done: d.buildsPassed > 0 },
    { icon: FileText, title: 'Create the report', text: 'Written only from sources you’re allowed to use', done: d.artifacts > 0 },
    { icon: ShoppingCart, title: 'Sell it with PayPal', text: 'Buyers pay you directly', done: d.verifiedSales > 0 },
    { icon: Users, title: 'Pay your contributors', text: 'Everyone gets their agreed share', done: d.paidOutCents > 0 && d.unsettledContributorCents === 0 },
  ];
  const currentStep = journey.findIndex((s) => !s.done);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{demo ? `You’re the demo publisher, ${user?.name ?? ''}` : `Welcome back${user ? `, ${user.name}` : ''}`}</h1>
        <p className="mt-1 text-muted">
          TracePay makes sure you’re allowed to sell the reports you create, collects payment with PayPal, and pays everyone whose work you used.
        </p>
      </div>

      {/* 1. What to do next */}
      <section className={clsx('flex flex-col gap-4 rounded-2xl border p-6 sm:flex-row sm:items-center sm:justify-between', style.box)}>
        <div className="flex gap-4">
          <div className="mt-0.5 shrink-0">{style.icon}</div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">What to do next</div>
            <h2 className="mt-1 text-xl font-semibold">{next.title}</h2>
            <p className={clsx('mt-1 max-w-xl', style.sub)}>{next.text}</p>
          </div>
        </div>
        {next.cta && (
          <Link to={next.cta.to} className={clsx('inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-5 font-medium', style.btn)}>
            {next.cta.label} <ArrowRight className="size-4" />
          </Link>
        )}
      </section>

      {demo && <GuidedTour d={d} />}

      {/* Reconciliation with PayPal: anything that needs a person */}
      {isPublisher && <NeedsAttention />}

      {/* 2. Where you are */}
      <section>
        <h2 className="mb-3 font-semibold">Your progress</h2>
        <ol className="grid gap-3 sm:grid-cols-4">
          {journey.map((s, i) => (
            <li
              key={s.title}
              className={clsx(
                'rounded-xl border bg-white p-4',
                s.done ? 'border-green-200' : i === currentStep ? 'border-ink ring-1 ring-ink' : 'border-line bg-slate-50',
              )}
            >
              <div className="flex items-center justify-between">
                <s.icon className={clsx('size-5', s.done ? 'text-pass' : 'text-slate-500')} />
                {s.done ? <CheckCircle2 className="size-5 text-pass" /> : <span className="text-xs font-medium text-muted">Step {i + 1}</span>}
              </div>
              <div className="mt-3 font-medium">{s.title}</div>
              <div className="mt-0.5 text-sm text-muted">{s.text}</div>
            </li>
          ))}
        </ol>
      </section>

      {/* 3. Money, in plain words */}
      <section className="grid gap-3 sm:grid-cols-3">
        <MoneyCard icon={<Wallet className="size-5" />} label="Earned from sales" value={d.verifiedSalesCents} note={d.verifiedSales === 1 ? '1 sale' : `${d.verifiedSales} sales`} />
        <MoneyCard icon={<HandCoins className="size-5" />} label="Paid to contributors" value={d.paidOutCents} note="Confirmed by PayPal" good />
        <MoneyCard icon={<Clock className="size-5" />} label="Still to pay contributors" value={d.unsettledContributorCents} note={d.unsettledContributorCents ? 'Waiting for you or PayPal' : 'Nothing outstanding'} />
      </section>

      {royalties.data && (
        <Link to="/royalties" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white p-5 hover:border-ink">
          <span className="flex items-center gap-3">
            <MessageSquareQuote className="size-5 text-slate-500" aria-hidden />
            <span>
              <span className="block font-medium">AI answers from your library</span>
              <span className="block text-sm text-muted">
                {royalties.data.answers === 1 ? '1 answer' : `${royalties.data.answers} answers`} ·{' '}
                {formatMoney(royalties.data.accrued.reduce((n, a) => n + a.amountCents, 0))} owed to contributors
              </span>
            </span>
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-medium">
            Answer royalties <ArrowRight className="size-4" aria-hidden />
          </span>
        </Link>
      )}

      {/* 4. What happened */}
      <section className="rounded-xl border border-line bg-white">
        <h2 className="border-b border-line px-5 py-3 font-semibold">What’s been happening</h2>
        {d.recentEvents.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">Nothing yet. Create your first report to get started.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.recentEvents.slice(0, 8).map((e) => {
              const a = describeEvent(e.eventType, e.payload ?? {});
              return (
                <li key={e.seq} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <span className="shrink-0">{TONE_ICON[a.tone]}</span>
                  <span className="flex-1">{a.text}</span>
                  <span className="shrink-0 text-xs text-muted">{timeAgo(e.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Technical details, for auditors and judges */}
      <section>
        <button onClick={() => setTechnical((t) => !t)} aria-expanded={technical} className="text-sm font-medium text-muted hover:text-ink">
          {technical ? 'Hide technical details ▲' : 'Show technical details ▼'}
        </button>
        {technical && (
          <div className="mt-3 space-y-4 rounded-xl border border-line bg-white p-5 text-sm">
            <div className="flex items-center gap-2">
              <ShieldCheck className={clsx('size-4', chain.data?.ok ? 'text-pass' : 'text-muted')} />
              {chain.isLoading
                ? 'Checking the audit log…'
                : chain.error || !chain.data
                  ? 'Couldn’t run the audit log check right now. Try again in a moment.'
                  : chain.data.ok
                    ? `Audit log is intact: all ${chain.data.length} events are hash-chained and unmodified.`
                    : `Audit log check FAILED: event #${chain.data.brokenAtSeq} was modified.`}
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
              <Tech label="Reports that passed the license check" value={d.buildsPassed} />
              <Tech label="Reports stopped by the license check" value={d.buildsBlocked} />
              <Tech label="Reports written" value={d.artifacts} />
              <Tech label="Sales PayPal confirmed" value={d.verifiedSales} />
              <Tech label="Payouts PayPal delivered" value={d.payoutsCompleted} />
              <Tech label="Payments that need a look" value={d.exceptions} />
            </dl>
            <ol className="divide-y divide-line">
              {d.recentEvents.map((e) => (
                <li key={e.seq} className="flex items-center justify-between gap-3 py-1.5">
                  <span>
                    <span className="mono mr-2 text-muted">#{e.seq}</span>
                    <span title={e.eventType}>{eventLabel(e.eventType)}</span>
                  </span>
                  <Hash value={e.hash} n={12} />
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>
    </div>
  );
}

function MoneyCard({ icon, label, value, note, good }: { icon: ReactNode; label: string; value: number; note: string; good?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-white p-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        {icon} {label}
      </div>
      <div className={clsx('mt-2 text-3xl font-semibold tabular-nums', good && value > 0 && 'text-pass')}>{formatMoney(value)}</div>
      <div className="mt-1 text-xs text-muted">{note}</div>
    </div>
  );
}

function Tech({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The demo's 3-minute path, one click per step — including the role switches, so nobody has to
 * find the role menu to see the buyer's and contributor's side.
 */
function GuidedTour({ d }: { d: Dashboard }) {
  const { users, switchUser } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<number | null>(null);
  const buyer = users.find((u) => u.role === 'buyer');
  const contributor = users.find((u) => u.id === 'user_okafor') ?? users.find((u) => u.role === 'contributor');
  const report = d.latestArtifact;
  const steps: Array<{ title: string; text: string; done: boolean; go: (() => Promise<void> | void) | null; hint?: string }> = [
    { title: 'Create a report', text: 'The license check stops a source that isn’t licensed for sale; the AI assistant finds a replacement and asks you.', done: d.artifacts > 0, go: () => navigate('/studio') },
    {
      title: 'Buy it with PayPal, as the buyer',
      text: 'Pay in the PayPal sandbox; the server verifies the payment before the report unlocks.',
      done: d.verifiedSales > 0,
      go: report && buyer ? async () => { await switchUser(buyer.id); navigate(`/store/${report.id}`); } : null,
      hint: 'Create a report first.',
    },
    { title: 'Pay the contributors', text: 'Approve the payment split; one PayPal Payouts batch pays everyone their share.', done: d.paidOutCents > 0, go: d.verifiedSales > 0 ? () => navigate('/settlements') : null, hint: 'Sell the report first.' },
    { title: 'Check the signed receipt', text: 'One record from sources to license check to PayPal payment to payouts, with a signature anyone can verify.', done: false, go: report ? () => navigate(`/reports/${report.id}/receipt`) : null, hint: 'Create a report first.' },
    { title: 'Ask a question that pays its sources', text: 'An AI answer pays each contributor for the passages it really used — and the live red team shows it can’t be gamed.', done: false, go: buyer ? async () => { await switchUser(buyer.id); navigate('/ask'); } : null },
    { title: 'See a contributor’s earnings', text: 'What each sale and each AI answer paid them, and why.', done: false, go: contributor ? async () => { await switchUser(contributor.id); navigate('/earnings'); } : null },
  ];
  return (
    <section aria-labelledby="tour" className="rounded-2xl border border-line bg-white p-5">
      <h2 id="tour" className="font-semibold">Guided demo · about 3 minutes</h2>
      <p className="mt-0.5 text-sm text-muted">Each step opens the right screen and switches role for you. PayPal sandbox only: no real money moves.</p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.title}>
            <button
              type="button"
              disabled={!s.go || busy !== null}
              title={!s.go ? s.hint : undefined}
              onClick={async () => {
                if (!s.go) return;
                setBusy(i);
                try {
                  await s.go();
                } finally {
                  setBusy(null);
                }
              }}
              className="flex h-full w-full items-start gap-3 rounded-xl border border-line p-3 text-left hover:border-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line"
            >
              <span className={clsx('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', s.done ? 'bg-verified-soft text-verified' : 'bg-slate-100 text-slate-700')}>
                {s.done ? <CheckCircle2 className="size-4" aria-label="Done" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{s.title}</span>
                <span className="block text-xs text-muted">{!s.go && s.hint ? s.hint : s.text}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
