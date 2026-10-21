import { Link } from 'react-router';
import { Card, PageHeader } from '../components/ui';

/**
 * Where PayPal sends the buyer after a full-page (non-popup) checkout. TracePay
 * confirms every payment with PayPal itself, so this page only explains what happens next.
 */
export function CheckoutReturnPage({ cancelled = false }: { cancelled?: boolean }) {
  return (
    <>
      <PageHeader title={cancelled ? 'Checkout cancelled' : 'Thanks — finishing your payment'} />
      <Card>
        <p className="text-sm text-slate-700">
          {cancelled
            ? 'You left PayPal before paying, so nothing was charged. You can go back to the report and try again whenever you like.'
            : 'PayPal sent you back to TracePay. We check every payment with PayPal ourselves, and the report unlocks as soon as PayPal confirms it — usually within a minute.'}
        </p>
        <Link to="/store" className="mt-4 inline-flex h-10 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-slate-800">
          Back to the Report Store
        </Link>
      </Card>
    </>
  );
}
