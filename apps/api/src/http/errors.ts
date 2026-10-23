import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { AssetError } from '../modules/assets/asset.service';
import { CryptoBusyError } from '../modules/auth/crypto';
import { UnknownAssetVersionError } from '../modules/catalog/catalog.service';
import { WebhookError } from '../modules/platform/webhooks';
import { LicenseError } from '../modules/licenses/license.service';
import { BuildStateError } from '../modules/generation/generation.service';
import { PaymentError } from '../modules/payments/payments.service';
import { SettlementError } from '../modules/settlements/engine';
import { SettlementStateError } from '../modules/settlements/settlement.service';
import { CreditError } from '../modules/answers/credits.service';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Transaction timed out or no pooled connection was free: the database is saturated, not broken. */
const DB_BUSY_CODES = new Set(['P2024', 'P2028']);

const PAYMENT_STATUS = { not_found: 404, not_for_sale: 409, state: 409, verification: 422, provider: 502, unconfirmed: 502 } as const;
const SETTLEMENT_STATUS = { not_found: 404, state: 409, payouts_unavailable: 503, provider: 502 } as const;
const LICENSE_STATUS = { not_found: 404, forbidden: 404, state: 409, invalid: 400 } as const;
const ASSET_STATUS = { not_found: 404, invalid: 400, unchanged: 409 } as const;
const CREDIT_STATUS = { insufficient_credit: 402, not_found: 404, invalid: 400 } as const;
const WEBHOOK_STATUS = { not_found: 404, invalid: 400, limit: 409, conflict: 409, state: 409 } as const;

export function toHttp(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  // Body-parser failures carry their own status: malformed JSON is the client's error, not ours.
  const parserType = (err as { type?: unknown } | null)?.type;
  if (parserType === 'entity.parse.failed') return new HttpError(400, 'The request body is not valid JSON.', { code: 'invalid_json' });
  if (parserType === 'entity.too.large') return new HttpError(413, 'The request body is too large.', { code: 'body_too_large' });
  if (parserType === 'encoding.unsupported' || parserType === 'charset.unsupported') return new HttpError(415, 'Unsupported request encoding.', { code: 'unsupported_encoding' });
  if (err instanceof ZodError) return new HttpError(400, 'Invalid request.', err.issues);
  if (err instanceof UnknownAssetVersionError) return new HttpError(400, err.message);
  if (err instanceof BuildStateError) return new HttpError(409, err.message);
  if (err instanceof PaymentError) return new HttpError(PAYMENT_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof SettlementStateError) return new HttpError(SETTLEMENT_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof SettlementError) return new HttpError(422, err.message);
  if (err instanceof LicenseError) return new HttpError(LICENSE_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof CryptoBusyError) return new HttpError(503, err.message, undefined, 2);
  if (err instanceof Prisma.PrismaClientKnownRequestError && DB_BUSY_CODES.has(err.code)) {
    return new HttpError(503, 'The server is busy. Please try again in a moment.', undefined, 2);
  }
  if (err instanceof AssetError) return new HttpError(ASSET_STATUS[err.code], err.message, { code: err.code });
  // 402 Payment Required: an agent can top up and retry.
  if (err instanceof CreditError) return new HttpError(CREDIT_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof WebhookError) return new HttpError(WEBHOOK_STATUS[err.code], err.message, { code: err.code === 'limit' ? 'resource_limit' : err.code });
  return new HttpError(500, 'Internal error.');
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const http = toHttp(err);
  // Unexpected errors are logged with the request id; clients only ever see a generic message.
  if (http.status >= 500 && !(err instanceof HttpError)) (req.log ?? console).error({ err }, 'unhandled error');
  if (http.retryAfterSeconds) res.setHeader('Retry-After', String(http.retryAfterSeconds));
  res.status(http.status).json({ error: http.message, ...(http.details !== undefined ? { details: http.details } : {}) });
}
