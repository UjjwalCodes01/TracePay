import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { UnknownAssetVersionError } from '../modules/catalog/catalog.service';
import { BuildStateError } from '../modules/generation/generation.service';
import { PaymentError } from '../modules/payments/payments.service';
import { SettlementError } from '../modules/settlements/engine';
import { SettlementStateError } from '../modules/settlements/settlement.service';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

const PAYMENT_STATUS = { not_found: 404, not_for_sale: 409, state: 409, verification: 422, provider: 502 } as const;
const SETTLEMENT_STATUS = { not_found: 404, state: 409, payouts_unavailable: 503, provider: 502 } as const;

function toHttp(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) return new HttpError(400, 'Invalid request.', err.issues);
  if (err instanceof UnknownAssetVersionError) return new HttpError(400, err.message);
  if (err instanceof BuildStateError) return new HttpError(409, err.message);
  if (err instanceof PaymentError) return new HttpError(PAYMENT_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof SettlementStateError) return new HttpError(SETTLEMENT_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof SettlementError) return new HttpError(422, err.message);
  return new HttpError(500, 'Internal error.');
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const http = toHttp(err);
  if (http.status >= 500 && !(err instanceof HttpError)) console.error(err);
  res.status(http.status).json({ error: http.message, ...(http.details !== undefined ? { details: http.details } : {}) });
}
