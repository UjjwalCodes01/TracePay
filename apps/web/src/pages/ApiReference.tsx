import { ArrowLeft, FileJson } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useDocumentTitle } from '../components/ui';

// Pinned: the interactive reference renders the live OpenAPI document of this deployment.
const SCALAR_SRC = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.4/dist/browser/standalone.js';
// Subresource Integrity: if the CDN copy ever changed, the browser refuses to run it on our origin.
const SCALAR_SRI = 'sha384-omTRdD9MbjA1vm12DqRUVvqJlr3VzSixvAdF1Jruu9AJOiJKyTKraIB6DyX+m10M';
const SPEC_URL = '/api/v1/openapi.json';

declare global {
  interface Window {
    Scalar?: { createApiReference: (el: Element | string, config: Record<string, unknown>) => { destroy?: () => void } };
  }
}

let loading: Promise<void> | null = null;
function loadScalar(): Promise<void> {
  if (window.Scalar) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCALAR_SRC;
    s.integrity = SCALAR_SRI;
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the API reference viewer.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function ApiReferencePage() {
  useDocumentTitle('API reference');
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let app: { destroy?: () => void } | undefined;
    let cancelled = false;
    loadScalar()
      .then(() => {
        if (cancelled || !host.current || !window.Scalar) return;
        app = window.Scalar.createApiReference(host.current, {
          url: SPEC_URL,
          hideClientButton: false,
          hideDarkModeToggle: true,
          showDeveloperTools: 'never',
          agent: { disabled: true },
          forceDarkModeState: 'light',
          defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
        });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      app?.destroy?.();
    };
  }, []);

  return (
    <div className="-mx-4 -my-6 md:-mx-8 md:-my-8">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white px-4 py-3 md:px-8">
        <Link to="/developers" className="inline-flex items-center gap-2 text-sm font-medium text-muted hover:text-ink">
          <ArrowLeft className="size-4" /> Developers
        </Link>
        <a href={SPEC_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline">
          <FileJson className="size-4" /> OpenAPI 3.1 (JSON)
        </a>
      </div>
      {error ? (
        <p className="p-8 text-sm text-block">
          {error} The raw specification is still available: <a className="underline" href={SPEC_URL}>{SPEC_URL}</a>.
        </p>
      ) : (
        <div ref={host} className="min-h-[70vh] bg-white" />
      )}
    </div>
  );
}
