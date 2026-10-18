import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Lock, ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ReportBody } from '../components/ReportBody';
import { Badge, Card, Empty, ErrorNote, Hash, PageHeader, Spinner } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import type { ArtifactFull, ArtifactPreview } from '../lib/types';

export function StorePage() {
  const q = useQuery({ queryKey: ['artifacts'], queryFn: () => api<{ artifacts: ArtifactPreview[] }>('/artifacts') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const items = q.data!.artifacts;

  return (
    <>
      <PageHeader title="Report Store" subtitle="Research reports built only from licensed sources. Part of every purchase is paid to the people whose work it uses." />
      {items.length === 0 ? (
        <Empty>No reports are listed yet. Switch to the Publisher role and build one in the Build Studio.</Empty>
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
    </>
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
  const q = useQuery({ queryKey: ['artifact', id], queryFn: () => api<{ artifact: ArtifactFull | ArtifactPreview; full: boolean }>(`/artifacts/${id}`) });
  const saleRef = useRef<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { artifact, full } = q.data!;

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
            {!full && (
              <>
                <p className="mb-4 mt-1 text-sm text-muted">Pay with your PayPal sandbox buyer account.</p>
                {!config?.paypalClientId ? (
                  <ErrorNote error={new Error('PayPal sandbox is not configured on the server.')} />
                ) : (
                  <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: 'USD', intent: 'capture', components: 'buttons' }}>
                    <PayPalButtons
                      style={{ layout: 'vertical', shape: 'rect', label: 'pay', height: 44 }}
                      fundingSource="paypal"
                      createOrder={async () => {
                        setError(null);
                        const r = await post<{ saleId: string; orderId: string }>('/checkout/orders', { artifactId: artifact.id });
                        saleRef.current = r.saleId;
                        return r.orderId;
                      }}
                      onApprove={async () => {
                        try {
                          // The server captures and verifies; returning from the popup proves nothing on its own.
                          const r = await post<CaptureResult>(`/checkout/${saleRef.current}/capture`);
                          setResult(r);
                          qc.invalidateQueries({ queryKey: ['artifact', id] });
                        } catch (e) {
                          setError(e);
                        }
                      }}
                      onCancel={() => setError(new Error('Checkout cancelled. No payment was taken.'))}
                      onError={(e) => setError(e instanceof Error ? e : new Error('PayPal reported an error.'))}
                    />
                  </PayPalScriptProvider>
                )}
              </>
            )}
            <ErrorNote error={error} />
          </Card>

          {result && (
            <Card title="Server-verified payment">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-pass">
                <CheckCircle2 className="size-4" /> {result.saleStatus === 'captured' ? 'Payment captured and verified' : `Sale ${result.saleStatus}`}
              </div>
              <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm">
                <dt className="text-muted">Order</dt>
                <dd><Hash value={result.orderId} n={20} /></dd>
                <dt className="text-muted">Capture</dt>
                <dd><Hash value={result.captureId} n={20} /></dd>
                <dt className="text-muted">Status</dt>
                <dd>{result.captureStatus}</dd>
                <dt className="text-muted">Amount</dt>
                <dd>{result.capturedCents !== null ? formatMoney(result.capturedCents) : '—'}</dd>
                <dt className="text-muted">Settlement</dt>
                <dd><Hash value={result.settlementRunId} n={20} /></dd>
              </dl>
              <p className="mt-3 text-xs text-muted">
                The server captured this order with PayPal and checked the amount, currency and sale reference before unlocking the report and calculating contributor royalties.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
