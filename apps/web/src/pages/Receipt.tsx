import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Badge, Button, Card, ErrorNote, Hash, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { api, post } from '../lib/api';
import { eventLabel, formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import type { SignedReceipt } from '../lib/types';

export function ReceiptPage() {
  const { id } = useParams();
  const { users } = useSession();
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => api<SignedReceipt>(`/artifacts/${id}/receipt`) });
  const verify = useMutation({
    mutationFn: (r: SignedReceipt) => post<{ valid: boolean }>('/receipts/verify', { document: r.document, signature: r.signature, publicKeyPem: r.publicKeyPem }),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const r = q.data!;
  const d = r.document;

  const download = () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tracepay-receipt-${d.artifact.id}.json`;
    a.click();
    // Some browsers start the download asynchronously: release the URL afterwards.
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };

  return (
    <>
      <PageHeader
        title="Audit receipt"
        subtitle={
          <>
            One signed record connecting <strong>{d.artifact.title}</strong> to its sources, rights check, PayPal sale, settlement and payouts.
            {d.view !== 'owner' && ` This is the ${d.view} view: it shows only what you’re entitled to see.`}
          </>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={download}>
              <Download className="size-4" /> Download JSON
            </Button>
            <Button loading={verify.isPending} onClick={() => verify.mutate(r)}>
              <ShieldCheck className="size-4" /> Verify signature
            </Button>
          </div>
        }
      />

      <div aria-live="polite">
        {verify.data && (
          <div className={`mb-6 flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium ${verify.data.valid ? 'bg-verified-soft text-verified' : 'bg-block-soft text-block'}`}>
            {verify.data.valid ? <ShieldCheck className="size-4" aria-hidden /> : <ShieldAlert className="size-4" aria-hidden />}
            {verify.data.valid ? 'Signature valid: this receipt has not been changed since TracePay issued it (Ed25519).' : 'Signature doesn’t match: this receipt was changed after it was issued.'}
          </div>
        )}
      </div>
      {verify.error ? (
        <div className="mb-6">
          <ErrorNote error={verify.error} />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="1 · The report">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-1.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-muted">Report</dt><dd><Hash value={d.artifact.id} n={24} /></dd>
            <dt className="text-muted">Content hash</dt><dd><Hash value={d.artifact.contentHash} n={24} /></dd>
            <dt className="text-muted">Written by</dt><dd>{d.artifact.fromFixture ? <Badge tone="warn">Written without AI (no model configured)</Badge> : d.artifact.model}</dd>
            <dt className="text-muted">Price</dt><dd>{formatMoney(d.artifact.priceCents)}</dd>
            <dt className="text-muted">Credits</dt><dd>{d.artifact.credits.join('; ') || '—'}</dd>
          </dl>
        </Card>

        <Card title="2 · License check">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-1.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-muted">Verdict</dt><dd><StatusBadge status={d.rights.preflight.verdict} /></dd>
            <dt className="text-muted">Policy</dt><dd className="mono break-all">{d.rights.preflight.policyVersion}</dd>
            <dt className="text-muted">Checked on</dt><dd>{d.rights.asOf}</dd>
            <dt className="text-muted">Rules checked</dt><dd>{d.rights.preflight.rulesEvaluated}</dd>
            <dt className="text-muted">Terms snapshot</dt><dd><Hash value={d.rights.snapshotHash} n={24} /></dd>
          </dl>
        </Card>

        <Card title="3 · Licensed sources" className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="hidden pb-2 font-medium sm:table-cell">Owner</th>
                  <th className="hidden pb-2 font-medium md:table-cell">License</th>
                  <th className="hidden pb-2 font-medium md:table-cell">SHA-256</th>
                  <th className="pb-2 font-medium">Cited</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.sources.map((s) => (
                  <tr key={s.assetVersionId}>
                    <td className="py-2 pr-3 font-medium">
                      {s.title} <span className="text-xs text-muted">v{s.version}</span>
                      <span className="block text-xs font-normal text-muted sm:hidden">{s.owner}</span>
                    </td>
                    <td className="hidden py-2 pr-3 sm:table-cell">{s.owner}</td>
                    <td className="mono hidden break-all py-2 pr-3 md:table-cell">{s.licenseId}</td>
                    <td className="hidden py-2 pr-3 md:table-cell"><Hash value={s.sha256} /></td>
                    <td className="py-2">{s.cited ? <Badge tone="pass">Yes</Badge> : <Badge>No</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="4 · Sales, settlement and payouts" className="lg:col-span-2">
          {d.sales.length === 0 ? (
            <p className="text-sm text-muted">No verified sales yet.</p>
          ) : (
            <div className="space-y-6">
              {d.sales.map((s) => (
                <div key={s.saleId} className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <StatusBadge status={s.status} />
                    <span>PayPal order <Hash value={s.paypal.orderId} n={18} /></span>
                    <span>payment <Hash value={s.paypal.captureId} n={18} /></span>
                    <span className="font-medium">
                      {formatMoney(s.paypal.capturedCents)} {s.paypal.captureStatus ? <StatusBadge status={s.paypal.captureStatus} /> : null}
                    </span>
                  </div>
                  {s.settlement && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted">
                          <tr>
                            <th className="pb-1 pr-3 font-medium">Recipient</th>
                            <th className="hidden pb-1 pr-3 font-medium md:table-cell">Calculation</th>
                            <th className="pb-1 text-right font-medium">Amount</th>
                            <th className="pb-1 pl-4 font-medium">Payout</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {s.settlement.lines.map((l, i) => (
                            <tr key={i}>
                              <td className="py-1.5 pr-3">
                                {(l as { recipientName?: string | null }).recipientName ?? names[l.recipientId] ?? l.recipientId}
                                <span className="mono block break-all text-xs text-muted md:hidden">{l.formula}</span>
                              </td>
                              <td className="mono hidden py-1.5 pr-3 md:table-cell">{l.formula}</td>
                              <td className="py-1.5 text-right tabular-nums">{formatMoney(l.amountCents)}</td>
                              <td className="py-1.5 pl-4">{l.payout ? <StatusBadge status={l.payout.status} /> : <span className="text-muted">{l.kind === 'publisher_residual' ? 'Kept by the publisher' : '—'}</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="5 · Audit trail" className="lg:col-span-2" action={<Badge tone={d.chain.verified ? 'pass' : 'block'}>{d.chain.verified ? 'Hash chain verified' : 'Hash chain broken'}</Badge>}>
          <ol className="divide-y divide-line text-sm">
            {d.auditTrail.map((e) => (
              <li key={e.seq} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
                <span className="min-w-0"><span className="mono mr-2 text-muted">#{e.seq}</span><span className="capitalize">{eventLabel(e.eventType)}</span></span>
                <Hash value={e.hash} n={12} />
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Signature" className="lg:col-span-2">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-muted">Algorithm</dt><dd>{r.algorithm}</dd>
            <dt className="text-muted">Signature</dt><dd className="mono break-all">{r.signature}</dd>
            <dt className="text-muted">Public key</dt><dd><pre className="mono whitespace-pre-wrap break-all text-slate-700">{r.publicKeyPem}</pre></dd>
          </dl>
          <p className="mt-3 text-xs text-muted">{d.disclaimer}</p>
          <Link to={`/reports/${d.artifact.id}/provenance`} className="mt-3 inline-block text-sm font-medium text-brand hover:underline">Open the provenance graph →</Link>
        </Card>
      </div>
    </>
  );
}
