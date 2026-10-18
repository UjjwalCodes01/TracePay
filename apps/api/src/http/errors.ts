import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AssetError } from '../modules/assets/asset.service';
import { UnknownAssetVersionError } from '../modules/catalog/catalog.service';
import { LicenseError } from '../modules/licenses/license.service';
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
const LICENSE_STATUS = { not_found: 404, forbidden: 404, state: 409, invalid: 400 } as const;
const ASSET_STATUS = { not_found: 404, invalid: 400, unchanged: 409 } as const;

function toHttp(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) return new HttpError(400, 'Invalid request.', err.issues);
  if (err instanceof UnknownAssetVersionError) return new HttpError(400, err.message);
  if (err instanceof BuildStateError) return new HttpError(409, err.message);
  if (err instanceof PaymentError) return new HttpError(PAYMENT_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof SettlementStateError) return new HttpError(SETTLEMENT_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof SettlementError) return new HttpError(422, err.message);
  if (err instanceof LicenseError) return new HttpError(LICENSE_STATUS[err.code], err.message, { code: err.code });
  if (err instanceof AssetError) return new HttpError(ASSET_STATUS[err.code], err.message, { code: err.code });
  return new HttpError(500, 'Internal error.');
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const http = toHttp(err);
  // Unexpected errors are logged with the request id; clients only ever see a generic message.
  if (http.status >= 500 && !(err instanceof HttpError)) (req.log ?? console).error({ err }, 'unhandled error');
  res.status(http.status).json({ error: http.message, ...(http.details !== undefined ? { details: http.details } : {}) });
}
