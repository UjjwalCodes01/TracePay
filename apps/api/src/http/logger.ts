import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  // Never log credentials, session cookies or PayPal signatures.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'req.headers["paypal-transmission-sig"]', 'req.headers["x-tracepay-proxy-secret"]'],
    censor: '[redacted]',
  },
});

/** Structured request logging with a request id that is echoed back to the client. */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/api/ready' },
});
