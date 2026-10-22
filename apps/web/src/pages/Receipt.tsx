import { useMutation, useQuery } from '@tanstack/react-query';
import { describeFormula, formatDay, RULE_LABELS, type RuleId } from '@tracepay/shared';
import { ArrowLeft, Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Badge, Button, Card, ErrorNote, Hash, PageHeader, Spinner, StatusBadge, TechnicalDetails } from '../components/ui';
import { api, post } from '../lib/api';
import { eventLabel, formatDateTime, formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import type { SignedReceipt } from '../lib/types';

const DL = 'grid grid-cols-[7rem_minmax(0,1fr)] gap-y-1.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]';

const VIEW_NAME = { buyer: 'buyer’s', contributor: 'contributor’s' } as const;

export function ReceiptPage() {
  const { id } = useParams();
  const { users } = useSession();
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => api<SignedReceipt>(`/artifacts/${id}/receipt`) });
  const verify = useMutation({
    mutationFn: (r: SignedReceipt) => post<{ valid: boolean }>('/receipts/verify', { document: r.document, signature: r.signature, publicKeyPem: r.publicKeyPem }),
  });
  // One switch for every "Technical details" section; each can still be opened on its own.
  const body = useRef<HTMLDivElement>(null);
  const [technical, setTechnical] = useState(false);
  const toggleTechnical = () => {
    const next = !technical;
    body.current?.querySelectorAll('details').forEach((el) => (el.open = next));
    setTechnical(next);
  };

  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const r = q.data;
  const d = r.document;
  const passed = d.rights.preflight.verdict === 'pass';
  const confirmedCents = d.sales.reduce((sum, s) => sum + s.paypal.capturedCents, 0);
  // When the licenses were checked, as a moment in the viewer's time (like every other event here).
  const checkedAt = d.auditTrail.find((e) => e.eventType === 'build.preflight_passed' || e.eventType === 'build.preflight_blocked')?.at ?? null;
  const checkedOn = checkedAt ? formatDateTime(checkedAt) : formatDay(d.rights.asOf);
  const paidAt = d.auditTrail.filter((e) => e.eventType === 'sale.captured').map((e) => e.at);
  const buyerPaid =
    d.view === 'buyer' && d.sales.length > 0
      ? `You paid ${formatMoney(confirmedCents)} with PayPal${d.sales.length === 1 && paidAt.length === 1 ? ` on ${formatDateTime(paidAt[0])}` : ''}, and PayPal confirmed the payment.`
      : null;
  const recipientName = (l: { recipientId: string; recipientName?: string | null }) => l.recipientName ?? names[l.recipientId] ?? 'A contributor';

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
      <Link to={`/reports/${d.artifact.id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Back to the report
      </Link>
      <PageHeader
        title="Receipt"
        subtitle={
          <>
            One signed record of <strong>{d.artifact.title}</strong>: the sources it used, the license check, the PayPal payment and who was paid.
            {d.view !== 'owner' && ` This is the ${VIEW_NAME[d.view]} copy: it shows only what’s yours to see.`}
          </>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={toggleTechnical} aria-pressed={technical}>
              {technical ? 'Hide technical details' : 'Show technical details'}
            </Button>
            <Button variant="secondary" onClick={download}>
              <Download className="size-4" /> Download receipt
            </Button>
            <Button loading={verify.isPending} onClick={() => verify.mutate(r)}>
              <ShieldCheck className="size-4" /> Check signature
            </Button>
          </div>
        }
      />

      <div aria-live="polite">
        {verify.data && (
          <div className={`mb-6 flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium ${verify.data.valid ? 'bg-verified-soft text-verified' : 'bg-block-soft text-block'}`}>
            {verify.data.valid ? <ShieldCheck className="size-4" aria-hidden /> : <ShieldAlert className="size-4" aria-hidden />}
            {verify.data.valid ? 'The signature checks out: this receipt hasn’t been changed since TracePay issued it.' : 'The signature doesn’t match: this receipt was changed after TracePay issued it.'}
          </div>
        )}
      </div>
      {verify.error ? (
        <div className="mb-6">
          <ErrorNote error={verify.error} />
        </div>
      ) : null}

      <Card title="In short" className="mb-6">
        <ul className="space-y-2 text-sm">
          <li>
            {passed ? (
              <>Every source’s license was checked on {checkedOn}, and all of them allowed this report.</>
            ) : (
              <>The license check on {checkedOn} stopped this report.</>
            )}
          </li>
          <li>{d.artifact.fromFixture ? 'Written without AI: each finding is a key sentence from a licensed source.' : `Written with AI (${d.artifact.model}), using only passages from licensed sources.`}</li>
          <li>
            {d.sales.length === 0
              ? 'Not sold yet, so no one has been paid.'
              : (buyerPaid ?? `Sold ${d.sales.length === 1 ? 'once' : `${d.sales.length} times`}; PayPal confirmed ${formatMoney(confirmedCents)} in payments.`)}
          </li>
          <li className="flex items-start gap-2">
            {d.chain.verified ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-verified" aria-hidden /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-block" aria-hidden />}
            <span>
              {d.chain.verified
                ? 'Signed by TracePay, and its activity record is intact. Use “Check signature” to confirm nothing has changed.'
                : 'TracePay’s activity record failed its integrity check. Treat this receipt with caution.'}
            </span>
          </li>
        </ul>
      </Card>

      <div ref={body} className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="1 · The report">
          <dl className={DL}>
            <dt className="text-muted">Report</dt><dd className="font-medium">{d.artifact.title}</dd>
            <dt className="text-muted">Written by</dt><dd>{d.artifact.fromFixture ? <Badge tone="warn">Written without AI (no AI model configured)</Badge> : d.artifact.model}</dd>
            <dt className="text-muted">Price</dt><dd>{formatMoney(d.artifact.priceCents)}</dd>
            <dt className="text-muted">Credit lines</dt><dd>{d.artifact.credits.join('; ') || 'None needed'}</dd>
          </dl>
          <TechnicalDetails>
            <dl className={DL}>
              <dt className="text-muted">Report ID</dt><dd><Hash value={d.artifact.id} n={24} /></dd>
              <dt className="text-muted">Content hash</dt><dd><Hash value={d.artifact.contentHash} n={24} /></dd>
              <dt className="text-muted">Receipt format</dt><dd className="mono break-all">{d.receiptVersion}</dd>
              <dt className="text-muted">Issued</dt><dd>{formatDateTime(d.issuedAt)} <span className="mono break-all text-xs text-muted">({d.issuedAt})</span></dd>
            </dl>
          </TechnicalDetails>
        </Card>

        <Card title="2 · License check">
          <dl className={DL}>
            <dt className="text-muted">Result</dt><dd><StatusBadge status={d.rights.preflight.verdict} /></dd>
            <dt className="text-muted">Checked on</dt><dd>{checkedOn}</dd>
            <dt className="text-muted">Checks made</dt><dd>{d.rights.preflight.rulesEvaluated}</dd>
            {d.rights.preflight.failed.length > 0 && (
              <>
                <dt className="text-muted">Didn’t pass</dt>
                <dd>{[...new Set(d.rights.preflight.failed)].map((f) => RULE_LABELS[f as RuleId] ?? f).join('; ')}</dd>
              </>
            )}
          </dl>
          <TechnicalDetails>
            <dl className={DL}>
              <dt className="text-muted">Policy</dt><dd className="mono break-all">{d.rights.preflight.policyVersion}</dd>
              <dt className="text-muted">Terms as of</dt><dd className="mono">{d.rights.asOf} (UTC)</dd>
              <dt className="text-muted">Terms snapshot</dt><dd><Hash value={d.rights.snapshotHash} n={24} /></dd>
              <dt className="text-muted">Build ID</dt><dd><Hash value={d.rights.buildId} n={24} /></dd>
              {d.rights.preflight.failed.length > 0 && (
                <>
                  <dt className="text-muted">Failed rules</dt><dd className="mono break-all">{d.rights.preflight.failed.join(', ')}</dd>
                </>
              )}
            </dl>
          </TechnicalDetails>
        </Card>

        <Card title="3 · Licensed sources" className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="hidden pb-2 font-medium sm:table-cell">Contributor</th>
                  <th className="pb-2 font-medium">Cited in the report</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.sources.map((s) => (
                  <tr key={s.assetVersionId}>
                    <td className="py-2 pr-3 font-medium">
                      {s.title} <span className="text-xs font-normal text-muted">version {s.version}</span>
                      <span className="block text-xs font-normal text-muted sm:hidden">{s.owner}</span>
                    </td>
                    <td className="hidden py-2 pr-3 sm:table-cell">{s.owner}</td>
                    <td className="py-2">{s.cited ? <Badge tone="pass">Yes</Badge> : <Badge>No</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TechnicalDetails>
            <ul className="space-y-2">
              {d.sources.map((s) => (
                <li key={s.assetVersionId} className="space-y-0.5">
                  <div className="font-medium">{s.title} (version {s.version})</div>
                  <div className="text-xs text-muted">Source version <Hash value={s.assetVersionId} n={24} /></div>
                  <div className="text-xs text-muted">License <span className="mono break-all">{s.licenseId ?? '—'}</span></div>
                  <div className="text-xs text-muted">SHA-256 <Hash value={s.sha256} n={24} /></div>
                </li>
              ))}
            </ul>
          </TechnicalDetails>
        </Card>

        <Card title="4 · Sales and who was paid" className="lg:col-span-2">
          {d.sales.length === 0 ? (
            <p className="text-sm text-muted">No sales yet. When someone buys this report, the payment and each contributor’s share appear here.</p>
          ) : (
            <div className="space-y-6">
              {d.sales.map((s, n) => (
                <div key={s.saleId} className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-medium">Sale {d.sales.length > 1 ? n + 1 : ''}</span>
                    <StatusBadge status={s.status} />
                    <span>{d.view === 'buyer' ? 'You paid' : 'PayPal confirmed'} <span className="font-medium tabular-nums">{formatMoney(s.paypal.capturedCents)}</span></span>
                  </div>
                  {s.settlement ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted">
                          <tr>
                            <th className="pb-1 pr-3 font-medium">Paid to</th>
                            <th className="hidden pb-1 pr-3 font-medium md:table-cell">Why</th>
                            <th className="pb-1 text-right font-medium">Amount</th>
                            <th className="pb-1 pl-4 font-medium">PayPal payout</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {s.settlement.lines.map((l, i) => (
                            <tr key={i}>
                              <td className="py-1.5 pr-3">
                                {recipientName(l)}
                                <span className="block text-xs text-muted md:hidden">{describeFormula(l.formula)}</span>
                              </td>
                              <td className="hidden py-1.5 pr-3 md:table-cell" title={l.formula}>{describeFormula(l.formula)}</td>
                              <td className="py-1.5 text-right tabular-nums">{formatMoney(l.amountCents)}</td>
                              <td className="whitespace-nowrap py-1.5 pl-4">{l.payout ? <StatusBadge status={l.payout.status} /> : <span className="text-muted">{l.kind === 'publisher_residual' ? 'Kept by the publisher' : 'Not sent yet'}</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    d.view !== 'buyer' && <p className="text-sm text-muted">Contributors’ shares haven’t been worked out for this sale yet.</p>
                  )}
                  <TechnicalDetails>
                    <dl className={DL}>
                      <dt className="text-muted">PayPal order</dt><dd><Hash value={s.paypal.orderId} n={24} /></dd>
                      <dt className="text-muted">PayPal payment ID</dt><dd><Hash value={s.paypal.captureId} n={24} /></dd>
                      <dt className="text-muted">PayPal status</dt><dd className="mono">{s.paypal.captureStatus || '—'}</dd>
                      {s.settlement && (
                        <>
                          <dt className="text-muted">Payment split</dt><dd><Hash value={s.settlement.runId} n={24} /></dd>
                          <dt className="text-muted">Total split</dt><dd>{formatMoney(s.settlement.grossCents)}</dd>
                          <dt className="text-muted">Rounding</dt><dd className="break-words">{s.settlement.roundingRule}</dd>
                        </>
                      )}
                    </dl>
                    {s.settlement && s.settlement.lines.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {s.settlement.lines.map((l, i) => (
                          <li key={i} className="text-xs">
                            <span className="text-muted">{recipientName(l)}:</span> <span className="mono break-all">{l.formula}</span>
                            {l.licenseId && <span className="mono break-all text-muted"> · {l.licenseId}</span>}
                            {l.payout?.transactionId && <span className="mono break-all text-muted"> · PayPal transaction {l.payout.transactionId}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.settlement && s.settlement.payoutBatches.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {s.settlement.payoutBatches.map((b) => (
                          <li key={b.senderBatchId} className="text-xs">
                            <span className="text-muted">Payout attempt {b.attempt}:</span> <span className="mono break-all">{b.senderBatchId}</span>
                            {b.paypalBatchId && <span className="mono break-all text-muted"> · PayPal batch {b.paypalBatchId}</span>} <span className="mono text-muted">({b.status})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TechnicalDetails>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="5 · What happened, in order" className="lg:col-span-2" action={<Badge tone={d.chain.verified ? 'pass' : 'block'} className="whitespace-nowrap">{d.chain.verified ? 'Record intact' : 'Record changed'}</Badge>}>
          <ol className="divide-y divide-line text-sm">
            {d.auditTrail.map((e) => (
              <li key={e.seq} className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span className="min-w-0">{eventLabel(e.eventType)}</span>
                <time className="text-xs text-muted sm:text-right" dateTime={e.at}>{formatDateTime(e.at)}</time>
              </li>
            ))}
          </ol>
          <TechnicalDetails>
            <p className="mb-2 text-xs text-muted">
              Every event is chained to the one before it by its hash, so changing any past event breaks the chain.
              {d.chain.verified ? ' The chain was verified when this receipt was issued.' : ' The chain did not verify when this receipt was issued.'}
            </p>
            <ol className="space-y-1">
              {d.auditTrail.map((e) => (
                <li key={e.seq} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                  <span className="min-w-0"><span className="mono mr-2 text-muted">#{e.seq}</span><span className="mono">{e.eventType}</span></span>
                  <Hash value={e.hash} n={12} />
                </li>
              ))}
            </ol>
            {d.chain.headSeq !== null && (
              <p className="mt-2 text-xs text-muted">
                These are the {d.auditTrail.length} events about this report. TracePay keeps one chain for everything it records, and it had reached event #{d.chain.headSeq} <Hash value={d.chain.headHash} n={12} /> when this receipt was issued.
              </p>
            )}
          </TechnicalDetails>
        </Card>

        <Card title="Signature" className="lg:col-span-2">
          <p className="text-sm">TracePay signs every receipt, so anyone can check that it hasn’t been changed since it was issued.</p>
          <TechnicalDetails>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-muted">Algorithm</dt><dd>{r.algorithm}</dd>
              <dt className="text-muted">Signature</dt><dd className="mono break-all">{r.signature}</dd>
              <dt className="text-muted">Public key</dt><dd className="min-w-0"><pre className="mono overflow-x-auto whitespace-pre text-xs text-slate-700">{r.publicKeyPem}</pre></dd>
            </dl>
          </TechnicalDetails>
          <p className="mt-3 text-xs text-muted">{d.disclaimer}</p>
          <Link to={`/reports/${d.artifact.id}/provenance`} className="mt-3 inline-block text-sm font-medium text-brand hover:underline">See where it came from →</Link>
        </Card>
      </div>
    </>
  );
}
