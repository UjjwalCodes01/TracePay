import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, GitBranch, Lock, ScrollText, ShieldCheck, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ReportBody } from '../components/ReportBody';
import { Badge, Card, Empty, ErrorNote, Hash, PageHeader, Spinner } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';
import type { ArtifactFull, ArtifactPreview } from '../lib/types';

export function StorePage() {
  const { user } = useSession();
  const q = useQuery({ queryKey: ['artifacts'], queryFn: () => api<{ artifacts: ArtifactPreview[] }>('/artifacts') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const items = q.data!.artifacts;

  return (
    <>
      <PageHeader
        title="Report Store"
        subtitle="Research reports built only from licensed sources. Part of every purchase is paid to the people whose work it uses."
        action={
          user?.role === 'buyer' ? (
            <Link to="/assistant" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-sm font-medium hover:bg-slate-50">
              <Sparkles className="size-4" /> Ask the Shopping Assistant
            </Link>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <Empty>No reports are listed yet. Switch to the Publisher role and create one.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((a) => (
            <Link key={a.id} to={`/store/${a.id}`} className="group rounded-xl border border-line bg-white p-5 transition hover:border-ink">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold group-hover:underline">{a.title}</h2>
                <span className="font-semibold tabular-nums">{formatMoney(a.priceCents)}</span>
              </div>
              {a.summary && <p className="mt-2 line-clamp-3 text-sm text-muted">{a.summary}</p>}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge tone="pass">
                  <ShieldCheck className="size-3" /> Licensed sources
                </Badge>
                <Badge>{a.sources.length} contributors</Badge>
              </div>
            </Link>
          ))}
        </div>
      )}
      {user?.role === 'buyer' && <MyPurchases />}
    </>
  );
}

interface BuyerSale {
  id: string;
  status: 'pending_payment' | 'captured' | 'payment_failed' | 'refunded' | 'exception';
  amountCents: number;
  createdAt: string;
  artifact: { id: string; title: string };
  payment: { captureId: string | null } | null;
}

/** What the buyer should understand about each purchase. Unfinished or declined checkouts never charged anyone, so they aren't listed. */
const PURCHASE_STATE: Partial<Record<BuyerSale['status'], { label: string; tone: 'pass' | 'warn' | 'block' | 'neutral' }>> = {
  captured: { label: 'Paid', tone: 'pass' },
  pending_payment: { label: 'PayPal is processing', tone: 'warn' },
  exception: { label: 'Being checked with PayPal', tone: 'warn' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

function MyPurchases() {
  const q = useQuery({ queryKey: ['my-purchases'], queryFn: () => api<{ sales: BuyerSale[] }>('/sales') });
  const purchases = (q.data?.sales ?? []).filter((s) => PURCHASE_STATE[s.status] && (s.status !== 'pending_payment' || s.payment?.captureId));
  if (q.error) return <div className="mt-8"><ErrorNote error={q.error} /></div>;
  if (!purchases.length) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-3 font-semibold">My purchases</h2>
      <ul className="divide-y divide-line rounded-xl border border-line bg-white">
        {purchases.map((s) => {
          const state = PURCHASE_STATE[s.status]!;
          return (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <Link to={`/store/${s.artifact.id}`} className="font-medium hover:underline">
                  {s.artifact.title}
                </Link>
                <div className="text-xs text-muted">Bought {timeAgo(s.createdAt)}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular-nums">{formatMoney(s.amountCents)}</span>
                <Badge tone={state.tone}>{state.label}</Badge>
                {s.status === 'captured' && (
                  <Link to={`/reports/${s.artifact.id}/receipt`} className="text-brand hover:underline">
                    Receipt
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface CaptureResult {
  saleId: string;
  saleStatus: string;
  orderId: string;
  captureId: string | null;
  captureStatus: string | null;
  capturedCents: number | null;
  settlementRunId: string | null;
  alreadyCaptured: boolean;
}

export function StoreItemPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { config } = useSession();
  const saleRef = useRef<string | null>(null);
  // Set when we already showed why checkout couldn't start, so PayPal's generic onError doesn't replace it.
  const shownRef = useRef(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  // PayPal accepted the payment but is still holding it: keep checking until the report unlocks.
  const waiting = result?.saleStatus === 'pending_payment' || result?.saleStatus === 'exception';
  const q = useQuery({
    queryKey: ['artifact', id],
    queryFn: () => api<{ artifact: ArtifactFull | ArtifactPreview; full: boolean }>(`/artifacts/${id}`),
    refetchInterval: (query) => (waiting && !query.state.data?.full ? 4000 : false),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['artifact', id] });
    qc.invalidateQueries({ queryKey: ['artifacts'] });
    qc.invalidateQueries({ queryKey: ['my-purchases'] });
  };
  const fail = (e: unknown) => {
    setError(e);
    // The report may have been withdrawn or already bought: show what is true now.
    refresh();
  };

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { artifact, full } = q.data!;
  const showPay = !full && !waiting && result?.saleStatus !== 'captured';

  return (
    <>
      <PageHeader title={artifact.title} subtitle={<Link to="/store" className="text-brand hover:underline">← All reports</Link>} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          {full ? (
            <ReportBody artifact={artifact as ArtifactFull} />
          ) : (
            <div className="space-y-4">
              {artifact.summary && <p className="leading-relaxed text-slate-700">{artifact.summary}</p>}
              <div className="rounded-lg border border-dashed border-line p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Lock className="size-4" /> Included in the full report
                </div>
                <ul className="list-disc pl-5 text-sm text-muted">
                  {artifact.sectionHeadings.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </div>
              <div className="text-sm">
                <div className="mb-1 font-medium">Built from</div>
                <ul className="space-y-0.5 text-muted">
                  {artifact.sources.map((s) => (
                    <li key={s.title}>{s.title}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title={full ? 'Purchased' : 'Buy this report'}>
            <div className="text-3xl font-semibold tabular-nums">{formatMoney(artifact.priceCents)}</div>
            {full && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Link to={`/reports/${artifact.id}/receipt`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3 text-sm font-medium text-white hover:bg-slate-800">
                  <ScrollText className="size-4" /> Receipt
                </Link>
                <Link to={`/reports/${artifact.id}/provenance`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-medium hover:bg-slate-50">
                  <GitBranch className="size-4" /> Where it came from
                </Link>
              </div>
            )}
            {showPay && (
              <>
                <p className="mb-4 mt-1 text-sm text-muted">Pay with a PayPal sandbox (test) account or a test card. No real money moves.</p>
                {!config?.paypalClientId ? (
                  <ErrorNote error={new Error('PayPal sandbox is not configured on the server.')} />
                ) : (
                  <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: 'USD', intent: 'capture', components: 'buttons' }}>
                    <PayPalButtons
                      style={{ layout: 'vertical', shape: 'rect', label: 'pay', height: 44 }}
                      createOrder={async () => {
                        setError(null);
                        shownRef.current = false;
                        try {
                          const r = await post<{ saleId: string; orderId: string }>('/checkout/orders', { artifactId: artifact.id });
                          saleRef.current = r.saleId;
                          return r.orderId;
                        } catch (e) {
                          shownRef.current = true;
                          fail(e);
                          throw e;
                        }
                      }}
                      onApprove={async () => {
                        try {
                          // The server captures and verifies; returning from the popup proves nothing on its own.
                          const r = await post<CaptureResult>(`/checkout/${saleRef.current}/capture`);
                          setResult(r);
                          if (r.saleStatus === 'payment_failed') setError(new Error('PayPal didn’t complete this payment, so nothing was charged. You can try again.'));
                          refresh();
                        } catch (e) {
                          fail(e);
                        }
                      }}
                      onCancel={() => setError(new Error('Checkout cancelled. No payment was taken.'))}
                      onError={(e) => {
                        // Errors we raised in createOrder are already shown.
                        if (!shownRef.current) fail(e instanceof Error ? e : new Error('PayPal reported an error. No payment was taken.'));
                      }}
                    />
                  </PayPalScriptProvider>
                )}
                {config?.sandboxBuyerHint && (
                  <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted">
                    <span className="font-medium text-ink">Test buyer:</span> {config.sandboxBuyerHint}
                  </p>
                )}
              </>
            )}
            <ErrorNote error={error} />
          </Card>

          {result && result.saleStatus !== 'payment_failed' && <PaymentResult result={result} unlocked={full} />}
        </div>
      </div>
    </>
  );
}

function PaymentResult({ result, unlocked }: { result: CaptureResult; unlocked: boolean }) {
  const captured = result.saleStatus === 'captured' || unlocked;
  return (
    <Card title="Your payment">
      {captured ? (
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-pass">
          <CheckCircle2 className="size-4" /> Payment received and checked with PayPal
        </div>
      ) : (
        <div className="mb-3 flex items-start gap-2 text-sm font-medium text-amber-700">
          <Clock className="mt-0.5 size-4 shrink-0" />
          {result.saleStatus === 'pending_payment'
            ? 'PayPal is still processing this payment. The report unlocks as soon as PayPal confirms it — you can leave this page.'
            : 'We’re double-checking this payment with PayPal. The report unlocks once it’s confirmed.'}
        </div>
      )}
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-muted">Order</dt>
        <dd><Hash value={result.orderId} n={20} /></dd>
        <dt className="text-muted">Capture</dt>
        <dd><Hash value={result.captureId} n={20} /></dd>
        <dt className="text-muted">Amount</dt>
        <dd>{result.capturedCents !== null ? formatMoney(result.capturedCents) : '—'}</dd>
      </dl>
      <p className="mt-3 text-xs text-muted">
        TracePay confirmed this payment with PayPal itself and checked the amount before unlocking the report and working out what each contributor is owed.
      </p>
    </Card>
  );
}
