import { Link } from 'react-router';
import { Card, PageHeader } from '../components/ui';

/** An unknown address inside the app: say so, rather than silently jumping to the start page. */
export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Card>
        <p className="text-sm text-muted">There’s no page at this address. It may have moved, or the link may be mistyped.</p>
        <Link to="/" className="mt-4 inline-flex h-10 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-slate-800">
          Go to your start page
        </Link>
      </Card>
    </>
  );
}
