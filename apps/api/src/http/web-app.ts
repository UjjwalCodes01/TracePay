import express, { Router, type Response } from 'express';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Serves the built web app (apps/web/dist) from the API's own origin, so one service is the whole
 * product: no second host to keep up, and session cookies stay first-party.
 *
 * Its own security headers: the API's lock-down CSP (default-src 'none') would block the app. This
 * one allows the app's own files plus what PayPal's JS SDK documents it needs (frames, connections
 * and images on *.paypal.com, *.paypalobjects.com, *.venmo.com). Inline styles are allowed (React
 * style attributes and the PayPal buttons use them). Inline scripts are not — except those carrying
 * this page's nonce: a fresh random value per page, handed to PayPal's SDK (data-csp-nonce), which
 * tags the scripts it injects with it, as PayPal documents.
 */

const nonceOf = (res: Response) => res.locals.cspNonce as string;

const PAYPAL = ['https://*.paypal.com', 'https://*.paypalobjects.com'];
const PAYPAL_FRAMES = [...PAYPAL, 'https://*.venmo.com'];

export function webApp(distDir: string): Router {
  const index = path.join(distDir, 'index.html');
  if (!existsSync(index)) throw new Error(`WEB_DIST_DIR has no index.html: ${distDir}`);
  const html = readFileSync(index, 'utf8');
  if (!html.includes('</head>')) throw new Error('index.html has no </head>.');
  const r = Router();
  r.use((req, _res, next) => (req.path === '/api' || req.path.startsWith('/api/') ? next('router') : next()));
  r.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });
  r.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...PAYPAL, (_req, res) => `'nonce-${nonceOf(res as Response)}'`],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', ...PAYPAL],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", ...PAYPAL_FRAMES],
          frameSrc: PAYPAL_FRAMES,
          childSrc: PAYPAL_FRAMES,
          formAction: ["'self'", ...PAYPAL],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      // PayPal's checkout popup must be able to report back to the page that opened it.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  r.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  // Every page is the single-page app (it routes in the browser), carrying this response's nonce
  // for the PayPal SDK. index.html itself is served the same way, never as a plain file.
  const page = (_req: express.Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html.replace('</head>', `<meta name="csp-nonce" content="${nonceOf(res)}"></head>`));
  };
  r.get('/index.html', page);
  // Hashed bundles never change: cache them for a year. Everything else is checked each time.
  r.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, file) => res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    }),
  );
  // A missing bundle is a 404, never the app's HTML (which would fail as a script).
  r.use('/assets', (_req, res) => res.status(404).type('text/plain').send('Not found.'));
  r.get(/.*/, page);
  return r;
}
