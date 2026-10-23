import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { quotas } from '../http/limits';
import { askLibrary, getAnswer, listAnswers, listLibraries } from '../modules/answers/answers.service';
import { captureTopUp, creditSummary, MAX_TOP_UP_CENTS, refillDemoCredit, startTopUp } from '../modules/answers/credits.service';
import { runRedTeam } from '../modules/answers/integrity';
import { latestRedTeam } from '../modules/answers/red-team';
import { contributorAnswerEarnings, refreshRoyaltyPayout, royaltySummary, sendRoyaltyPayout, submitRoyaltyPayout } from '../modules/answers/royalties.service';
import { HttpError } from '../http/errors';

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);

export const AskBody = z.object({
  libraryId: z.string().min(1).max(64),
  question: z.string().trim().min(8).max(500),
  /** The most this answer may cost, in cents ($0.01 – $5.00). */
  maxPriceCents: z.number().int().min(1).max(500),
});

/** Pay-per-citation answers: buyers ask and pay, contributors earn, publishers pay out. */
export function answerRoutes({ db, paypal, signingKeys, answerWriter, config }: AppDeps) {
  const r = Router();

  // ---- asking (buyers) --------------------------------------------------------------

  r.get('/libraries', requireRole('buyer', 'publisher', 'admin'), async (_req, res) => {
    res.json({ libraries: await listLibraries(db) });
  });

  r.get('/credits', requireRole('buyer'), async (req, res) => {
    if (config.demoSharedBuyer) await refillDemoCredit(db, currentUser(req).id);
    res.json(await creditSummary(db, currentUser(req).id));
  });

  r.post('/credits/top-ups', requireRole('buyer'), quotas.checkout(), async (req, res) => {
    const { amountCents } = z.object({ amountCents: z.number().int().min(100).max(MAX_TOP_UP_CENTS) }).parse(req.body);
    res.status(201).json(await startTopUp(db, paypal(), { ownerId: currentUser(req).id, amountCents, appBaseUrl: config.appBaseUrl }));
  });

  r.post('/credits/top-ups/:id/capture', requireRole('buyer'), async (req, res) => {
    res.json(await captureTopUp(db, paypal(), param(req, 'id'), currentUser(req).id));
  });

  r.post('/answers', requireRole('buyer'), quotas.answer(), async (req, res) => {
    const body = AskBody.parse(req.body);
    if (config.demoSharedBuyer) await refillDemoCredit(db, currentUser(req).id);
    res.status(201).json({ answer: await askLibrary(db, answerWriter(), signingKeys(), { askerId: currentUser(req).id, ...body }) });
  });

  r.get('/answers', requireRole('buyer'), async (req, res) => {
    res.json({ answers: await listAnswers(db, currentUser(req).id) });
  });

  r.get('/answers/integrity', async (_req, res) => {
    // Rules enforced in code (budget, padding, invented sources…), checked on every request, and the
    // latest AI red team: attacks Gemini wrote against the AI defences, scored with every miss shown.
    const attacks = runRedTeam();
    res.json({
      attacks,
      caught: attacks.filter((a) => a.caught).length,
      total: attacks.length,
      overpaidCents: attacks.filter((a) => !a.caught).reduce((n, a) => n + a.paidCents, 0),
      redTeam: await latestRedTeam(),
    });
  });

  r.get('/answers/:id', requireRole('buyer'), async (req, res) => {
    res.json({ answer: await getAnswer(db, param(req, 'id'), currentUser(req).id, signingKeys()) });
  });

  // ---- royalties (publisher runs the library) -----------------------------------------

  r.get('/royalties', requireRole('publisher'), async (req, res) => {
    res.json(await royaltySummary(db, currentUser(req).id));
  });

  r.post('/royalties/payouts', requireRole('publisher'), async (req, res) => {
    res.status(201).json({ payout: await sendRoyaltyPayout(db, paypal(), currentUser(req).id) });
  });

  const ownPayout = async (req: Request) => {
    const payout = await db.royaltyPayout.findFirst({ where: { id: param(req, 'id'), libraryId: currentUser(req).id }, select: { id: true } });
    if (!payout) throw new HttpError(404, 'Payout not found.');
    return payout.id;
  };
  r.post('/royalties/payouts/:id/refresh', requireRole('publisher'), async (req, res) => {
    res.json({ payout: await refreshRoyaltyPayout(db, paypal(), await ownPayout(req)) });
  });
  r.post('/royalties/payouts/:id/resend', requireRole('publisher'), async (req, res) => {
    res.json({ payout: await submitRoyaltyPayout(db, paypal(), await ownPayout(req)) });
  });

  // ---- contributors ---------------------------------------------------------------------

  r.get('/contributor/answer-earnings', requireRole('contributor'), async (req, res) => {
    res.json(await contributorAnswerEarnings(db, currentUser(req).id));
  });

  return r;
}
