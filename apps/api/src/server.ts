import cors from 'cors';
import express from 'express';
import { serverEnv } from './config/env';

const env = serverEnv();
const app = express();

app.use(cors({ origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()) }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'tracepay-api', paypalEnv: 'sandbox' });
});

app.listen(env.PORT, () => {
  console.log(`TracePay API listening on :${env.PORT}`);
});
