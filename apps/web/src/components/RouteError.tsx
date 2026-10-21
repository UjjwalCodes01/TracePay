import { isRouteErrorResponse, useRouteError } from 'react-router';

/** Shown instead of a blank or developer error page when a screen crashes or fails to load. */
export function RouteError() {
  const error = useRouteError();
  // After a redeploy, an open tab may ask for page code that no longer exists.
  const stale = error instanceof Error && /dynamically imported module|Importing a module script failed|Failed to fetch|ChunkLoadError/i.test(error.message);
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-16">
      <div role="alert" className="w-full max-w-md rounded-2xl border border-line bg-white p-8 text-center shadow-sm">
        <img src="/favicon.svg" alt="" className="mx-auto mb-4 size-8" />
        <h1 className="text-lg font-semibold">{notFound ? 'Page not found' : stale ? 'TracePay was updated' : 'Something went wrong'}</h1>
        <p className="mt-2 text-sm text-muted">
          {notFound
            ? 'This page doesn’t exist.'
            : stale
              ? 'A newer version is available. Reload to continue — nothing you saved is lost.'
              : 'This screen hit an unexpected problem. Reloading usually fixes it.'}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button onClick={() => window.location.reload()} className="inline-flex h-10 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-slate-800">
            Reload
          </button>
          <a href="/" className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-medium hover:bg-slate-50">
            Go to start page
          </a>
        </div>
      </div>
    </div>
  );
}
