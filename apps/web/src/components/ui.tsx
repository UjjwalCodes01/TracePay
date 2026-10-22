import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Evidence } from '../lib/types';

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
        variant === 'primary' && 'bg-ink text-white hover:bg-slate-800',
        variant === 'secondary' && 'border border-line bg-white text-ink hover:bg-slate-50',
        variant === 'ghost' && 'text-muted hover:bg-slate-100 hover:text-ink',
        variant === 'danger' && 'border border-red-200 bg-white text-block hover:bg-red-50',
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
      {children}
    </button>
  );
}

export function Card({ className, children, title, action }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={clsx('rounded-xl border border-line bg-white', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Names the browser tab (and history entry) after the page. */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · TracePay` : 'TracePay';
  }, [title]);
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const TONES = {
  neutral: 'bg-slate-100 text-slate-700',
  pass: 'bg-verified-soft text-verified',
  block: 'bg-block-soft text-block',
  warn: 'bg-contract-soft text-contract',
  info: 'bg-recorded-soft text-recorded',
  ai: 'bg-ai-soft text-ai',
} as const;

export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>{children}</span>;
}

export const EVIDENCE: Record<Evidence, { label: string; tone: keyof typeof TONES; color: string; description: string }> = {
  verified: { label: 'Verified by PayPal', tone: 'pass', color: 'var(--color-verified)', description: 'Returned by the PayPal API and checked by the server.' },
  recorded: { label: 'Recorded event', tone: 'info', color: 'var(--color-recorded)', description: 'Something TracePay itself did, logged as it happened.' },
  ai_interpretation: { label: 'AI interpretation', tone: 'ai', color: 'var(--color-ai)', description: 'A model’s claim, validated against retrieval records but not proof.' },
  contractual: { label: 'Contractual', tone: 'warn', color: 'var(--color-contract)', description: 'Follows from approved, frozen license terms.' },
};

export function EvidenceBadge({ evidence }: { evidence: Evidence }) {
  const e = EVIDENCE[evidence];
  return <Badge tone={e.tone}>{e.label}</Badge>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'block' | 'pass' }) {
  return (
    <div className="rounded-xl border border-line bg-white px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone === 'block' && 'text-block', tone === 'pass' && 'text-pass')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-8 text-sm text-muted">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> {label ?? 'Loading…'}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line bg-white px-6 py-10 text-center text-sm text-muted">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-block">{(error as Error).message}</div>;
}

export function Hash({ value, n = 10 }: { value: string | null | undefined; n?: number }) {
  if (!value) return <span className="text-muted">—</span>;
  return (
    <span className="mono break-all rounded bg-slate-100 px-1.5 py-0.5 text-slate-700" title={value}>
      {value.length > n ? `${value.slice(0, n)}…` : value}
    </span>
  );
}

export function statusTone(status: string): keyof typeof TONES {
  if (['captured', 'completed', 'SUCCESS', 'pass', 'generated', 'approved', 'COMPLETED', 'listed'].includes(status)) return 'pass';
  if (['exception', 'FAILED', 'RETURNED', 'BLOCKED', 'REVERSED', 'block', 'preflight_blocked', 'generation_failed', 'payment_failed', 'failed', 'refunded', 'DENIED', 'DUPLICATE_REJECTED', 'SUBMIT_FAILED'].includes(status)) return 'block';
  if (['PENDING', 'PROCESSING', 'UNCLAIMED', 'ONHOLD', 'payout_submitted', 'pending_payment', 'awaiting_approval', 'running', 'calculated'].includes(status)) return 'warn';
  return 'neutral';
}

/** Every status the API reports, in plain words. Anything new falls back to a readable form. */
export const STATUS_LABEL: Record<string, string> = {
  // checks and verdicts
  pass: 'Passed',
  block: 'Blocked',
  // sales and PayPal captures
  pending_payment: 'Waiting for payment',
  captured: 'Paid',
  payment_failed: 'Not paid',
  refunded: 'Refunded',
  exception: 'Needs a look',
  COMPLETED: 'Completed',
  DECLINED: 'Declined',
  PARTIALLY_REFUNDED: 'Partly refunded',
  // settlements
  calculated: 'Calculated',
  approved: 'Approved',
  payout_submitted: 'Payouts sent',
  completed: 'Completed',
  // payout batches and items
  SUBMITTING: 'Sending to PayPal',
  SUBMIT_FAILED: 'PayPal didn’t accept it',
  AWAITING_CONFIRMATION: 'Waiting for PayPal to confirm',
  DUPLICATE_REJECTED: 'Already sent',
  PENDING: 'On its way',
  PROCESSING: 'On its way',
  SUCCESS: 'Paid',
  DENIED: 'Declined by PayPal',
  CANCELED: 'Cancelled',
  FAILED: 'Failed',
  UNCLAIMED: 'Waiting to be claimed',
  RETURNED: 'Returned',
  ONHOLD: 'On hold at PayPal',
  BLOCKED: 'Blocked by PayPal',
  REFUNDED: 'Taken back',
  REVERSED: 'Reversed',
  // licenses
  requested: 'Requested',
  draft: 'Draft',
  offered: 'Offered',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  revoked: 'Revoked',
  superseded: 'Replaced by newer terms',
  // agent runs
  running: 'Working',
  awaiting_approval: 'Waiting for you',
  failed: 'Stopped',
  // builds and reports
  preflight_blocked: 'Blocked by a license',
  preflight_passed: 'Licenses check out',
  generating: 'Being written',
  generated: 'Written',
  generation_failed: 'Writing failed',
  listed: 'For sale',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}
