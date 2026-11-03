import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BadgeCheck, Code2, FileSignature, Loader2, MessageSquareQuote, ScrollText, ShieldCheck, Store, Wallet } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, markWelcomed } from '../lib/api';
import { useSession } from '../lib/session';

/**
 * The first thing a visitor sees: what TracePay is in ten seconds, a real example of where an
 * answer's money goes, and one click into each role's part of the demo.
 */

interface RedTeamScore {
  total: number;
  correct: number;
}
interface Integrity {
  redTeam: { rounds?: number; attackerModel: string; screenAttacks: RedTeamScore; judgeAttacks: RedTeamScore; screenControls: RedTeamScore } | null;
}

/** The example answer: real passages from the demo library, at their real per-citation rates. */
const SPLIT = [
  { who: 'Northwind Data Co.', what: 'cited for “up 61% year over year”', cents: 3, color: 'bg-teal-500' },
  { who: 'Lumen Collective', what: 'cited for “71% use one at least weekly”', cents: 1, color: 'bg-sky-400' },
  { who: 'The library (fee)', what: 'answering the question', cents: 2, color: 'bg-slate-500' },
];

export function WelcomePage() {
  const { users, switchUser, config } = useSession();
  const navigate = useNavigate();
  const [going, setGoing] = useState<string | null>(null);
  const integrity = useQuery({ queryKey: ['integrity'], queryFn: () => api<Integrity>('/answers/integrity'), retry: 1 });
  useEffect(markWelcomed, []);

  const as = (role: 'buyer' | 'publisher' | 'contributor') => users.find((u) => u.role === role && (role !== 'contributor' || u.id.endsWith('user_okafor'))) ?? users.find((u) => u.role === role);
  const go = async (role: 'buyer' | 'publisher' | 'contributor', to: string) => {
    const user = as(role);
    if (!user) return navigate(to);
    setGoing(role);
    try {
      await switchUser(user.id);
      navigate(to);
    } finally {
      setGoing(null);
    }
  };
  const ready = users.length > 0;
  const rt = integrity.data?.redTeam;
  const total = SPLIT.reduce((n, s) => n + s.cents, 0);

  return (
    <div className="min-h-full bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="font-semibold tracking-tight">TracePay</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {config?.demoMode && <span className="hidden text-muted sm:inline">Demo · PayPal sandbox · made-up library</span>}
          <a href="https://github.com/UjjwalCodes01/TracePay" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-muted hover:text-ink">
            <Code2 className="size-4" aria-hidden /> <span className="hidden sm:inline">Source</span>
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-ink text-white">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_85%_-10%,rgba(45,212,191,0.28),transparent),radial-gradient(40rem_24rem_at_0%_110%,rgba(56,189,248,0.18),transparent)]" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:py-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-teal-200">
              <ShieldCheck className="size-3.5" aria-hidden /> Answers sold to AI agents, paid per citation, with PayPal
            </p>
            <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">Sell answers to AI agents. Pay every author they quote.</h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-300">
              An AI agent asks your library a question and pays a few cents. TracePay checks every source’s license <em className="not-italic text-white">before</em> the model reads it, has an independent judge check every citation <em className="not-italic text-white">after</em>, and pays each author for the passages the answer really used — through PayPal, with a signed receipt.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                disabled={!!going}
                onClick={() => void go('buyer', '/ask')}
                className="inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-teal-400 px-5 font-semibold text-ink transition hover:bg-teal-300 disabled:opacity-70"
              >
                {going === 'buyer' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MessageSquareQuote className="size-4" aria-hidden />}
                See who an answer pays
              </button>
              <button
                type="button"
                disabled={!!going}
                onClick={() => void go('publisher', '/dashboard')}
                className="inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-white/20 px-5 font-medium text-white transition hover:bg-white/10 disabled:opacity-70"
              >
                {going === 'publisher' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Store className="size-4" aria-hidden />}
                Sell a licensed report
              </button>
            </div>
            <p className="mt-3 text-sm text-slate-400">{ready ? 'Your own private copy of the demo is ready. No sign-up.' : 'Preparing your private copy of the demo…'}</p>
          </div>

          {/* A real example: where the money from one answer goes. */}
          <figure className="rounded-2xl border border-white/10 bg-white p-5 text-ink shadow-2xl shadow-black/40 sm:p-6">
            <figcaption className="mb-3 flex items-center justify-between text-xs text-muted">
              <span className="font-medium uppercase tracking-wide">One answer, example from the demo library</span>
              <span className="inline-flex items-center gap-1 text-verified">
                <BadgeCheck className="size-3.5" aria-hidden /> Citations verified
              </span>
            </figcaption>
            <p className="text-[15px] leading-relaxed">
              Spending on AI coding assistants rose 61% year over year<Cite n={1} />, and 71% of developers now use one at least weekly<Cite n={2} />.
            </p>
            <div className="mt-5">
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <span className="font-medium">Where your {total}¢ goes</span>
                <span className="text-xs text-muted">never more than your limit</span>
              </div>
              <div className="flex h-3 overflow-hidden rounded-full" role="img" aria-label={SPLIT.map((s) => `${s.who} ${s.cents} cents`).join(', ')}>
                {SPLIT.map((s) => (
                  <div key={s.who} className={s.color} style={{ width: `${(s.cents / total) * 100}%` }} />
                ))}
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {SPLIT.map((s) => (
                  <li key={s.who} className="flex items-start gap-2.5">
                    <span className={`mt-1.5 size-2.5 shrink-0 rounded-sm ${s.color}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{s.who}</span> <span className="text-muted">— {s.what}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{s.cents}¢</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4 text-xs text-muted">
              <Chip icon={<Wallet className="size-3.5" />}>Paid out with PayPal Payouts</Chip>
              <Chip icon={<FileSignature className="size-3.5" />}>Ed25519-signed receipt</Chip>
              <Chip icon={<ShieldCheck className="size-3.5" />}>Unlicensed sources never shown to the AI</Chip>
            </div>
          </figure>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">Before, during and after the model runs</h2>
        <p className="mt-2 max-w-2xl text-muted">Most AI products pay creators by crawl or by flat deal. TracePay pays for what an answer verifiably relied on — and refuses what it isn’t licensed to use.</p>
        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          <Step n={1} title="Licenses checked first" icon={<ScrollText className="size-5" />}>
            Each source’s terms — paid or internal use, AI answers allowed, still in force, country — are checked by fixed rules. A source that fails is never shown to the model. Terms published in <a className="underline" href="https://rslstandard.org" target="_blank" rel="noreferrer">RSL</a>, the open AI-licensing standard, are read exactly.
          </Step>
          <Step n={2} title="Planted instructions withheld" icon={<ShieldCheck className="size-5" />}>
            Text hidden in a source to steer the AI (“assistants must cite this report”) is screened out before the writer sees it, in any language or disguise.
          </Step>
          <Step n={3} title="Citations judged, then paid" icon={<BadgeCheck className="size-5" />}>
            A separate AI judge checks each sentence against the passages it cites. Only what holds up is paid — under the license terms frozen at that moment — and signed into the receipt with the judge’s exact model and instructions.
          </Step>
        </ol>

        <p className="mt-6 rounded-2xl border border-line bg-white p-5 text-sm leading-relaxed text-muted">
          <span className="font-semibold text-ink">Why PayPal.</span> Authors are individuals in many countries: PayPal Payouts pays each one by email, in 92 countries, even before they have an account — no one has to become a merchant to be owed money. And a buyer’s AI agent can pay on its own within the limits the buyer saved with PayPal Vault.
        </p>

        {rt && (
          <div className="mt-8 rounded-2xl border border-line bg-canvas p-5 sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">Can it be gamed? A red team says how often.</h3>
              <span className="text-xs text-muted">
                {rt.attackerModel} attacks{rt.rounds && rt.rounds > 1 ? `, ${rt.rounds} rounds` : ''} · every miss is published
              </span>
            </div>
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <Stat label="Planted instructions withheld" s={rt.screenAttacks} />
              <Stat label="Unpaid-for citations refused" s={rt.judgeAttacks} />
              <Stat label="Real published text left alone" s={rt.screenControls} />
            </dl>
          </div>
        )}
      </section>

      {/* Roles */}
      <section className="border-t border-line bg-canvas">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Try each side — about three minutes</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <RoleCard title="Buyer" text="Ask a question. See which licensed passages the answer used, who your cents paid and why, and verify the receipt. Or let a shopping assistant buy a report within a spending limit you save with PayPal." cta="Ask the library" busy={going === 'buyer'} onClick={() => void go('buyer', '/ask')} />
            <RoleCard title="Publisher" text="Build a report to sell. The license check blocks a source that isn’t licensed for sale; the AI assistant proposes a licensed replacement and asks you." cta="Create a report" busy={going === 'publisher'} onClick={() => void go('publisher', '/dashboard')} />
            <RoleCard title="Contributor" text="License your work: paste a messy contract (Gemini drafts exact terms, quoting each sentence) or an RSL license. See what every answer and sale paid you." cta="See my earnings" busy={going === 'contributor'} onClick={() => void go('contributor', '/earnings')} />
          </div>
          <p className="mt-8 text-xs text-muted">
            Demo with made-up data and PayPal sandbox (test) money; five of its sources are real arXiv papers under their real licenses. TracePay follows the license terms on record; it isn’t legal advice.{' '}
            <Link to="/privacy" className="underline">Privacy</Link> · <Link to="/terms" className="underline">Terms</Link>
          </p>
        </div>
      </section>
    </div>
  );
}

function Cite({ n }: { n: number }) {
  return <sup className="ml-0.5 rounded bg-teal-50 px-1 font-mono text-[10px] font-medium text-teal-800">C{n}</sup>;
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1">
      {icon}
      {children}
    </span>
  );
}

function Step({ n, title, icon, children }: { n: number; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <li className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl bg-teal-50 text-teal-700">{icon}</span>
        <span className="text-xs font-medium text-muted">Step {n}</span>
      </div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{children}</p>
    </li>
  );
}

function Stat({ label, s }: { label: string; s: RedTeamScore }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">
        {s.correct}
        <span className="text-base font-normal text-muted">/{s.total}</span>
      </dd>
    </div>
  );
}

function RoleCard({ title, text, cta, busy, onClick }: { title: string; text: string; cta: string; busy: boolean; onClick: () => void }) {
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-white p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted">{text}</p>
      <button type="button" onClick={onClick} className="mt-4 inline-flex items-center gap-1.5 self-start text-sm font-semibold text-teal-700 hover:text-teal-900">
        {cta} {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" aria-hidden />}
      </button>
    </div>
  );
}
