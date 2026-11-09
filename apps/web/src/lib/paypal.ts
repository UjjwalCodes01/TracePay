import type { ReactPayPalScriptOptions } from '@paypal/react-paypal-js';

/**
 * The page's CSP nonce, when the server that sent the page set one (in production it does; the
 * Vite dev server doesn't). PayPal's SDK tags the scripts it injects with it, so the page's
 * Content-Security-Policy can allow PayPal without allowing any other inline script.
 */
function cspNonce(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined;
}

/** The PayPal JS SDK options every PayPal button on the site uses. */
export function paypalOptions(clientId: string): ReactPayPalScriptOptions {
  const nonce = cspNonce();
  return { clientId, currency: 'USD', intent: 'capture', components: 'buttons', ...(nonce ? { dataCspNonce: nonce } : {}) };
}
