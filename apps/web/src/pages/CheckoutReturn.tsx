import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { buttonClass, Card, PageHeader, Spinner } from '../components/ui';
import { api, ApiError, post } from '../lib/api';
import { formatMoney } from '../lib/format';

interface CaptureResult {
  saleId: string;
  saleStatus: string;
  capturedCents: number | null;
}

interface BuyerSale {
  id: string;
  status: string;
  amountCents: number;
  artifact: { id: string; title: string };
  payment: { captureId: string | null } | null;
}

/** Worth asking again: PayPal hasn't recorded the approval yet, or the server is busy or waking up. */
const transient = (e: unknown) =>
  e instanceof ApiError && (e.status === 0 || e.status >= 500 || (e.status === 409 && /not been approved/i.test(e.message)));

/**
 * Where PayPal sends the buyer after a full-page (non-popup) checkout. The server takes
 * and verifies the payment here — the return itself proves nothing — so the report
 * unlocks right away instead of waiting for a background check.
 */
export function CheckoutReturnPage({ cancelled = false }: { cancelled?: boolean }) {
  const [params] = useSearchParams();
  const saleId = params.get('sale');
  const qc = useQueryClient();

  const capture = useQuery({
    queryKey: ['checkout-return', saleId],
    queryFn: () => post<CaptureResult>(`/checkout/${saleId}/capture`),
    enabled: Boolean(saleId) && !cancelled,
    retry: (n, e) => n < 5 && transient(e),
    retryDelay: 3000,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const processing = capture.data?.saleStatus === 'pending_payment' || capture.data?.saleStatus === 'exception';
  // The buyer's own purchases: which report this was, and (while PayPal holds the payment) when it clears.
  const sales = useQuery({
    queryKey: ['my-purchases'],
    queryFn: () => api<{ sales: BuyerSale[] }>('/sales'),
    enabled: Boolean(saleId),
    refetchInterval: processing ? 5000 : false,
  });
  const sale = sales.data?.sales.find((s) => s.id === saleId);
  const paid = capture.data?.saleStatus === 'captured' || sale?.status === 'captured';

  useEffect(() => {
    if (!paid) return;
    qc.invalidateQueries({ queryKey: ['artifacts'] });
    if (sale) qc.invalidateQueries({ queryKey: ['artifact', sale.artifact.id] });
  }, [paid, sale, qc]);

  const back = sale ? (
    <Link to={`/store/${sale.artifact.id}`} className={buttonClass({ className: 'mt-4' })}>
      {paid ? 'Open the report' : 'Back to the report'}
    </Link>
  ) : (
    <Link to="/store" className={buttonClass({ className: 'mt-4' })}>
      Back to the report store
    </Link>
  );

  let body;
  if (cancelled) {
    body = <p>You left PayPal before paying, so nothing was charged. You can go back to the report and try again whenever you like.</p>;
  } else if (!saleId) {
    body = <p>This link is missing its checkout reference. If you paid, the report appears under “My purchases” in the store as soon as PayPal confirms it.</p>;
  } else if (paid) {
    const cents = capture.data?.capturedCents ?? sale?.amountCents ?? null;
    body = (
      <p className="flex items-start gap-2 font-medium text-pass">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Payment received{cents !== null ? ` (${formatMoney(cents)})` : ''} and checked with PayPal.{sale ? ` “${sale.artifact.title}” is yours.` : ' The report is yours.'}
        </span>
      </p>
    );
  } else if (processing) {
    body = (
      <p className="flex items-start gap-2 font-medium text-amber-700">
        <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>PayPal is still processing this payment. The report unlocks as soon as PayPal confirms it — you can leave this page.</span>
      </p>
    );
  } else if (capture.data?.saleStatus === 'payment_failed') {
    body = (
      <p className="flex items-start gap-2 font-medium text-block">
        <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>PayPal didn’t complete this payment, so nothing was charged. You can try again from the report.</span>
      </p>
    );
  } else if (capture.error) {
    const e = capture.error;
    const text =
      e instanceof ApiError && e.status === 404
        ? 'We couldn’t find this checkout for the account you’re signed in with. Sign in as the buyer who started it, then open this link again.'
        : e instanceof ApiError && e.status === 409 && /not been approved/i.test(e.message)
          ? 'PayPal hasn’t confirmed your approval yet, so nothing was charged. Go back to the report and try again.'
          : (e as Error).message;
    body = (
      <p className="flex items-start gap-2 text-block">
        <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{text}</span>
      </p>
    );
  } else {
    body = <Spinner label="Confirming your payment with PayPal…" />;
  }

  return (
    <>
      <PageHeader title={cancelled ? 'Checkout cancelled' : paid ? 'Payment complete' : 'Finishing your payment'} />
      <Card>
        <div aria-live="polite" className="text-sm text-slate-700">
          {body}
        </div>
        {back}
      </Card>
    </>
  );
}
