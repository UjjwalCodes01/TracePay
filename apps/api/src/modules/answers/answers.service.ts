import { answersEnv } from '../../config/env';
import { formatMoney } from '@tracepay/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { appendAudit, lockAuditChain } from '../audit/audit-log';
import { demoRoleOf, isDemoPersona, sameWorld, worldOf } from '../demo/world';
import { sha256Hex } from '../audit/hash-chain';
import { publicKeyPem, signDocument, type SigningKeys } from '../audit/signing';
import { todayUtc } from '../builds/preflight.service';
import { listCatalog, resolveSources } from '../catalog/catalog.service';
import type { AnswerWriter } from '../generation/writers';
import { retrievePassages } from '../generation/retrieval';
import { CreditError, lockAccount } from './credits.service';
import { auditAnswer, citationPairs, longestCopiedRun, MAX_PAID_PASSAGES_PER_SOURCE, MAX_VERBATIM_WORDS, planWithinBudget, type AnswerAudit, type Candidate, type Passage } from './integrity';
import { RuleSupportJudge } from './support';
import { withheldPassages } from '../sources/screening';
import { checkAnswerRights, type ExcludedSource } from './rights';

/**
 * Pay-per-citation answers. A question is answered from one publisher's licensed
 * library; the asker pays a small fee plus, for every passage the answer verifiably
 * relies on, that passage's license rate — which is credited to its contributor.
 *
 *   rights check → retrieval (licensed sources only) → fit to the asker's price limit
 *   → reserve the worst case → the model writes → citations audited → charge, credit,
 *   sign a receipt. The model never decides who is paid or how much.
 */

export const ANSWER_RECEIPT_VERSION = 'tracepay-answer-receipt/1';
export const answerFeeCents = () => answersEnv().ANSWER_FEE_CENTS ?? 2;
const PASSAGES_PER_SOURCE = MAX_PAID_PASSAGES_PER_SOURCE;


const json = (v: unknown) => v as Prisma.InputJsonValue;

/** The model gets this long; well inside the recovery sweep's window, so a hold is never stranded. */
export const WRITER_TIMEOUT_MS = 60_000;
/** The citation judge (embeddings + one model call) gets this long before the deterministic rule decides instead. */
export const JUDGE_TIMEOUT_MS = 45_000;

// Demo personas of any world (or the shared one): their free credit only pays demo contributors.

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the AI model took longer than ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface AskInput {
  askerId: string;
  libraryId: string;
  question: string;
  maxPriceCents: number;
  asOf?: string;
}

interface StoredContent {
  /** The answer, kept only when it was paid for (or is TracePay's own "not covered" note). */
  text: string | null;
  /** Every citation, with whether it was paid. Passage text is never stored here. */
  citations: Array<{ handle: string; assetVersionId: string | null; chunkId: string | null; supported: boolean; reason?: string; title?: string | null }>;
  /** What decided which citations were paid: an independent AI check ('model') or the deterministic rule. */
  checkedBy?: string;
  ignored: AnswerAudit['ignored'];
  passages: Array<{ handle: string; chunkId: string; assetVersionId: string; title?: string }>;
  /** Passages withheld from the model because they tried to instruct it. */
  withheld?: number;
}

export async function askLibrary(db: Db, writer: AnswerWriter, keys: SigningKeys, input: AskInput) {
  const asOf = input.asOf ?? todayUtc();
  const fee = answerFeeCents();
  if (input.maxPriceCents < fee) throw new CreditError(`The price limit must cover the ${formatMoney(fee)} answer fee.`, 'invalid');

  const library = await db.user.findUnique({ where: { id: input.libraryId }, select: { id: true, name: true, role: true } });
  // Another demo world's library doesn't exist, as far as this asker is concerned.
  if (!library || library.role !== 'publisher' || worldOf(library.id) !== worldOf(input.askerId)) throw new CreditError('Library not found.', 'not_found');

  // 1. Rights: only sources whose license allows AI answers, today.
  const entries = (await listCatalog(db, input.libraryId)).filter((e) => e.license);
  const sources = entries.length ? await resolveSources(db, input.libraryId, entries.map((e) => e.assetVersionId)) : [];
  const rights = checkAnswerRights(sources, asOf);
  const excluded = [...rights.excluded];
  // The demo's free credit only ever pays the demo's own (fictional) authors.
  const eligible = isDemoPersona(input.askerId)
    ? rights.eligible.filter((e) => {
        if (demoRoleOf(e.source.contributorId) === 'contributor') return true;
        excluded.push({ assetVersionId: e.source.assetVersionId, assetTitle: e.source.assetTitle, contributorName: e.source.contributorName, code: 'demo_only', reason: 'Demo credit can only pay the demo’s own contributors.' });
        return false;
      })
    : rights.eligible;
  const rateOf = new Map(eligible.map((e) => [e.source.assetVersionId, e.centsPerCitation]));
  const sourceOf = new Map(sources.map((s) => [s.assetVersionId, s]));

  // 2. Retrieval from licensed sources only, most relevant first; unrelated passages are dropped.
  const relevant = eligible.length ? (await retrievePassages(db, eligible.map((e) => e.source.assetVersionId), input.question, PASSAGES_PER_SOURCE)).filter((p) => p.rank > 0) : [];
  // Text that tries to steer the model never reaches it (pattern list, then — with AI on — a model screen).
  const blocked = await withheldPassages(db, relevant, writer.screen);
  const retrieved = relevant.filter((p) => !blocked.has(p.chunkId));
  const withheld = relevant.length - retrieved.length;
  for (const id of new Set(relevant.filter((p) => blocked.has(p.chunkId)).map((p) => p.assetVersionId))) {
    if (retrieved.some((p) => p.assetVersionId === id)) continue;
    const s = sourceOf.get(id)!;
    excluded.push({ assetVersionId: id, assetTitle: s.assetTitle, contributorName: s.contributorName, code: 'instructions', reason: 'Its text contains instructions aimed at AI, so it wasn’t shown to the model.' });
  }
  const bySource = new Map<string, typeof retrieved>();
  for (const p of [...retrieved].sort((a, b) => b.rank - a.rank)) bySource.set(p.assetVersionId, [...(bySource.get(p.assetVersionId) ?? []), p]);
  const candidates: Candidate[] = [...bySource].map(([assetVersionId, ps]) => ({
    assetVersionId,
    centsPerCitation: rateOf.get(assetVersionId) ?? 0,
    passages: ps.map((p) => ({ handle: p.handle, chunkId: p.chunkId, assetVersionId: p.assetVersionId, text: p.text })),
  }));

  // 3. The asker's mandate, enforced before the model runs.
  const plan = planWithinBudget(candidates, fee, input.maxPriceCents);
  const budgetExcluded: ExcludedSource[] = plan.trimmed
    .filter((t) => t.kept === 0)
    .map((t) => {
      const s = sourceOf.get(t.assetVersionId)!;
      return { assetVersionId: s.assetVersionId, assetTitle: s.assetTitle, contributorName: s.contributorName, code: 'over_budget' as const, reason: 'Left out to stay within your price limit.' };
    });
  const allExcluded = [...excluded, ...budgetExcluded];

  // Nothing licensed covers it: answered for free, with the reasons.
  if (plan.passages.length === 0) {
    return finishFree(db, keys, { input, library, excluded: allExcluded, text: eligible.length ? 'No licensed source in this library covers that question.' : 'This library has no sources licensed for AI answers.' });
  }

  // 4. Hold the worst case, so concurrent answers can never overspend the balance.
  const answer = await db.$transaction(async (tx) => {
    const account = await lockAccount(tx, input.askerId);
    const available = account.balanceCents - account.reservedCents;
    if (available < plan.worstCaseCents) {
      throw new CreditError(`This answer can cost up to ${formatMoney(plan.worstCaseCents)}, but your available credit is ${formatMoney(Math.max(0, available))}. Top up to continue.`, 'insufficient_credit');
    }
    await tx.creditAccount.update({ where: { id: account.id }, data: { reservedCents: { increment: plan.worstCaseCents } } });
    return tx.answer.create({
      data: { accountId: account.id, libraryId: library.id, question: input.question, maxPriceCents: input.maxPriceCents, reservedCents: plan.worstCaseCents, excluded: json(allExcluded) },
    });
  });

  // 5. The model writes (outside any transaction). One repair pass for invented citations or copying.
  const titled = plan.passages.map((p) => ({ ...p, title: sourceOf.get(p.assetVersionId)!.assetTitle }));
  const writerPassages = titled.map((p) => ({ handle: p.handle, text: p.text, sourceTitle: p.title }));
  const rates = plan.passages.map((p) => ({ assetVersionId: p.assetVersionId, centsPerCitation: rateOf.get(p.assetVersionId) ?? 0 }));
  const copied = (text: string) => plan.passages.some((p) => longestCopiedRun(text, p.text) > MAX_VERBATIM_WORDS);
  let out;
  let audit: AnswerAudit;
  const topic = input.question;
  try {
    out = await withTimeout(writer.answer({ question: input.question, passages: writerPassages }), WRITER_TIMEOUT_MS);
    audit = auditAnswer(out.text, plan.passages, rates, { topic });
    const problems = [
      ...audit.unknownHandles.map((h) => `[${h}] is not one of the excerpts.`),
      ...(copied(out.text) ? [`You copied more than ${MAX_VERBATIM_WORDS} words of an excerpt word for word. Paraphrase.`] : []),
    ];
    if (out.covered && problems.length) {
      out = await withTimeout(writer.answer({ question: input.question, passages: writerPassages, previousProblems: problems }), WRITER_TIMEOUT_MS);
      audit = auditAnswer(out.text, plan.passages, rates, { topic });
    }
    // Who gets paid is decided by an independent check of each citation, not by the writer.
    if (out.covered && !audit.unknownHandles.length && !copied(out.text)) {
      const pairs = citationPairs(out.text, plan.passages);
      const context = { corpus: plan.passages.map((p) => p.text), topic };
      const judge = writer.judge ?? new RuleSupportJudge();
      let verdicts;
      let checkedBy = judge.name;
      try {
        verdicts = await withTimeout(judge.judge(pairs, context), JUDGE_TIMEOUT_MS);
      } catch {
        // The judge is down: the deterministic rule decides (it can underpay, never overpay a decorative citation).
        verdicts = await new RuleSupportJudge().judge(pairs, context);
        checkedBy = 'rules';
      }
      audit = { ...auditAnswer(out.text, plan.passages, rates, { verdicts, topic }), checkedBy };
    }
  } catch (err) {
    await settle(db, keys, answer.id, { status: 'failed', failureReason: 'The AI model couldn’t answer in time. You were not charged.', detail: (err as Error).message, plan: titled, withheld });
    return getAnswer(db, answer.id, input.askerId, keys);
  }

  // 6. Charge only for a grounded, original answer; credit only verified citations.
  if (audit.unknownHandles.length) {
    await settle(db, keys, answer.id, { status: 'failed', failureReason: 'The answer cited sources it wasn’t given, so it was rejected. You were not charged.', out, audit, plan: titled, withheld });
  } else if (out.covered && copied(out.text)) {
    await settle(db, keys, answer.id, { status: 'failed', failureReason: 'The answer copied a source word for word, which its license doesn’t allow, so it was rejected. You were not charged.', out, audit, plan: titled, withheld });
  } else if (!out.covered || audit.paid.length === 0) {
    await settle(db, keys, answer.id, { status: 'not_covered', out, audit, plan: titled, withheld });
  } else {
    await settle(db, keys, answer.id, { status: 'answered', out, audit, plan: titled, feeCents: fee, sourceOf, withheld });
  }
  return getAnswer(db, answer.id, input.askerId, keys);
}

type TitledPassage = Passage & { title: string };
type SettleArgs = { withheld?: number } & (
  | { status: 'failed'; failureReason: string; detail?: string; out?: { text: string; model: string; fromFixture: boolean }; audit?: AnswerAudit; plan?: TitledPassage[] }
  | { status: 'not_covered'; out: { text: string; model: string; fromFixture: boolean }; audit: AnswerAudit; plan: TitledPassage[] }
  | { status: 'answered'; out: { text: string; model: string; fromFixture: boolean }; audit: AnswerAudit; plan: TitledPassage[]; feeCents: number; sourceOf: Map<string, Awaited<ReturnType<typeof resolveSources>>[number]> }
);

/** Releases the hold, charges (only a grounded answer), credits contributors, signs the receipt. */
async function settle(db: Db, keys: SigningKeys, answerId: string, args: SettleArgs) {
  await db.$transaction(async (tx) => {
    // Lock order everywhere: audit chain → account → answer row. Status is read under the
    // answer's own lock, so the recovery sweep and a late answer can't both settle it.
    await lockAuditChain(tx);
    const head = await tx.answer.findUnique({ where: { id: answerId }, select: { account: { select: { ownerId: true } } } });
    if (!head) return; // removed (a demo reset): nothing to settle
    await lockAccount(tx, head.account.ownerId);
    await tx.$queryRaw`SELECT id FROM "Answer" WHERE id = ${answerId} FOR UPDATE`;
    const answer = await tx.answer.findUniqueOrThrow({ where: { id: answerId }, include: { account: true, library: { select: { id: true, name: true } } } });
    if (answer.status !== 'answering') return; // already settled (e.g. by the recovery sweep)

    const charged = args.status === 'answered' ? args.feeCents + args.audit.contributorCents : 0;
    // The mandate was enforced when planning; this is the belt to those braces.
    if (charged > answer.maxPriceCents || charged > answer.reservedCents) throw new Error(`answer ${answerId} would exceed its limit`);

    await tx.creditAccount.update({ where: { id: answer.accountId }, data: { reservedCents: { decrement: answer.reservedCents }, balanceCents: { decrement: charged } } });
    if (charged > 0) await tx.creditEntry.create({ data: { accountId: answer.accountId, kind: 'answer', amountCents: -charged, answerId } });

    const credits =
      args.status === 'answered'
        ? args.audit.paid
            .filter((p) => p.amountCents > 0)
            .map((p) => {
              const s = args.sourceOf.get(p.assetVersionId)!;
              return {
                answerId,
                libraryId: answer.libraryId,
                contributorId: s.contributorId,
                assetVersionId: p.assetVersionId,
                assetTitle: s.assetTitle,
                licenseId: s.license!.id,
                termsHash: s.termsHash,
                centsPerCitation: p.centsPerCitation,
                citations: p.chunkIds.length,
                amountCents: p.amountCents,
              };
            })
        : [];
    if (credits.length) await tx.citationCredit.createMany({ data: credits });

    const titleOf = new Map((args.plan ?? []).map((p) => [p.assetVersionId, p.title]));
    // Only a paid answer keeps its text: an unpaid one must not hand out licensed content for free.
    const keepText = args.status === 'answered' || (args.status === 'not_covered' && args.out.model === 'none');
    const content: StoredContent | null = args.out
      ? {
          text: keepText ? args.out.text : null,
          citations: (args.audit?.citations ?? []).map((c) => ({ handle: c.handle, assetVersionId: c.assetVersionId, chunkId: c.chunkId, supported: c.supported, reason: c.reason, title: c.assetVersionId ? (titleOf.get(c.assetVersionId) ?? null) : null })),
          checkedBy: args.audit?.checkedBy ?? 'rules',
          ignored: args.audit?.ignored ?? { unsupported: 0, repeated: 0, overCap: 0 },
          passages: (args.plan ?? []).map((p) => ({ handle: p.handle, chunkId: p.chunkId, assetVersionId: p.assetVersionId, title: p.title })),
          withheld: args.withheld ?? 0,
        }
      : null;

    const finishedAt = new Date();
    const receipt = {
      receiptVersion: ANSWER_RECEIPT_VERSION,
      answerId,
      issuedAt: finishedAt.toISOString(),
      status: args.status,
      library: { id: answer.library.id, name: answer.library.name },
      askerAccountId: answer.accountId,
      questionSha256: sha256Hex(answer.question),
      answerSha256: args.out ? sha256Hex(args.out.text) : null,
      model: args.out?.model ?? null,
      fromFixture: args.out?.fromFixture ?? false,
      rules: { maxPaidPassagesPerSource: MAX_PAID_PASSAGES_PER_SOURCE, feeCents: args.status === 'answered' ? args.feeCents : 0, onlySupportedCitationsPaid: true },
      mandate: { maxPriceCents: answer.maxPriceCents },
      paid: credits.map((c) => ({ assetVersionId: c.assetVersionId, title: c.assetTitle, contributorId: c.contributorId, licenseId: c.licenseId, termsHash: c.termsHash, centsPerCitation: c.centsPerCitation, citations: c.citations, amountCents: c.amountCents })),
      notPaid: args.audit?.ignored ?? null,
      excluded: (answer.excluded as unknown as ExcludedSource[]).map((e) => ({ assetVersionId: e.assetVersionId, title: e.assetTitle, code: e.code })),
      chargedCents: charged,
      currency: 'USD',
    };
    await tx.answer.update({
      where: { id: answerId },
      data: {
        status: args.status,
        content: content ? json(content) : undefined,
        model: args.out?.model ?? null,
        fromFixture: args.out?.fromFixture ?? false,
        feeCents: args.status === 'answered' ? args.feeCents : 0,
        chargedCents: charged,
        failureReason: args.status === 'failed' ? args.failureReason : null,
        receipt: json(receipt),
        signature: signDocument(receipt, keys),
        finishedAt,
      },
    });
    await appendAudit(tx, {
      entityType: 'answer',
      entityId: answerId,
      tenantId: answer.libraryId,
      eventType: args.status === 'answered' ? 'answer.answered' : args.status === 'failed' ? 'answer.failed' : 'answer.not_covered',
      payload: { chargedCents: charged, paid: receipt.paid.map((p) => ({ assetVersionId: p.assetVersionId, citations: p.citations, amountCents: p.amountCents })), ...(args.status === 'failed' && args.detail ? { error: args.detail.slice(0, 300) } : {}) },
    });
  });
}

async function finishFree(db: Db, keys: SigningKeys, a: { input: AskInput; library: { id: string; name: string }; excluded: ExcludedSource[]; text: string }) {
  const answer = await db.$transaction(async (tx) => {
    const account = await lockAccount(tx, a.input.askerId);
    return tx.answer.create({ data: { accountId: account.id, libraryId: a.library.id, question: a.input.question, maxPriceCents: a.input.maxPriceCents, excluded: json(a.excluded) } });
  });
  const out = { text: a.text, model: 'none', fromFixture: false };
  await settle(db, keys, answer.id, { status: 'not_covered', out, audit: auditAnswer('', [], []), plan: [] });
  return getAnswer(db, answer.id, a.input.askerId, keys);
}

/** An answer as its asker sees it: text, who was paid and why, what was left out, the signed receipt. */
export async function getAnswer(db: Db, answerId: string, askerId: string, keys: SigningKeys) {
  const a = await db.answer.findUnique({
    where: { id: answerId },
    include: { account: { select: { ownerId: true } }, library: { select: { id: true, name: true } }, credits: { include: { contributor: { select: { name: true } } } } },
  });
  if (!a || a.account.ownerId !== askerId) throw new CreditError('Answer not found.', 'not_found');
  return answerOut(a, keys);
}

export async function listAnswers(db: Db, askerId: string, take = 30) {
  const rows = await db.answer.findMany({
    where: { account: { ownerId: askerId } },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, question: true, status: true, chargedCents: true, createdAt: true, library: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, question: r.question, status: r.status, chargedCents: r.chargedCents, createdAt: r.createdAt, libraryName: r.library.name }));
}

type AnswerRow = Prisma.AnswerGetPayload<{ include: { library: { select: { id: true; name: true } }; credits: { include: { contributor: { select: { name: true } } } } } }>;

export function answerOut(a: AnswerRow, keys: SigningKeys) {
  const content = a.content as unknown as StoredContent | null;
  const titleOf = new Map([...(content?.passages ?? []).map((p) => [p.assetVersionId, p.title ?? null] as const), ...a.credits.map((c) => [c.assetVersionId, c.assetTitle] as const)]);
  return {
    id: a.id,
    question: a.question,
    status: a.status,
    library: a.library,
    // Only a paid answer's text is returned; an unpaid one would hand out licensed content for free.
    text: a.status === 'answered' ? (content?.text ?? null) : a.status === 'not_covered' ? (content?.text ?? 'The licensed sources in this library don’t answer that question.') : null,
    model: a.model,
    fromFixture: a.fromFixture,
    // Which handle is which source (titles only — the asker never receives raw passages).
    citations:
      a.status === 'answered'
        ? (content?.citations ?? []).map((c) => ({ handle: c.handle, assetVersionId: c.assetVersionId, title: c.title ?? (c.assetVersionId ? (titleOf.get(c.assetVersionId) ?? null) : null), paid: c.supported && !!c.assetVersionId, reason: c.reason ?? null }))
        : [],
    citationsCheckedBy: content?.checkedBy ?? 'rules',
    withheldPassages: content?.withheld ?? 0,
    paid: a.credits.map((c) => ({ assetVersionId: c.assetVersionId, title: c.assetTitle, contributor: c.contributor.name, citations: c.citations, centsPerCitation: c.centsPerCitation, amountCents: c.amountCents })),
    notPaid: content?.ignored ?? { unsupported: 0, repeated: 0, overCap: 0 },
    excluded: (a.excluded as unknown as ExcludedSource[]).map((e) => ({ title: e.assetTitle, contributor: e.contributorName, code: e.code, reason: e.reason })),
    feeCents: a.feeCents,
    chargedCents: a.chargedCents,
    maxPriceCents: a.maxPriceCents,
    failureReason: a.failureReason,
    createdAt: a.createdAt,
    receipt: a.receipt && a.signature ? { document: a.receipt, signature: a.signature, algorithm: 'Ed25519' as const, publicKeyPem: publicKeyPem(keys) } : null,
  };
}

/** Publishers whose libraries can answer questions: at least one source licensed for AI answers. */
/** Libraries the viewer can ask: their own demo world's, or (for everyone else) any outside the demo worlds. */
export async function listLibraries(db: Db, viewerId?: string | null) {
  const grants = await db.licenseGrant.findMany({
    where: { status: 'approved', terms: { path: ['aiAnswers', 'allowed'], equals: true }, asset: { archivedAt: null }, licenseeId: sameWorld(viewerId) },
    select: { licenseeId: true, assetId: true, licensee: { select: { name: true, role: true } } },
  });
  // Distinct live sources per library (several versions of one grant count once).
  const libs = new Map<string, { id: string; name: string; assets: Set<string> }>();
  for (const g of grants) {
    if (g.licensee.role !== 'publisher') continue;
    const l = libs.get(g.licenseeId) ?? { id: g.licenseeId, name: g.licensee.name, assets: new Set<string>() };
    l.assets.add(g.assetId);
    libs.set(g.licenseeId, l);
  }
  return [...libs.values()].map((l) => ({ id: l.id, name: l.name, sources: l.assets.size })).sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
}

/** Answers interrupted mid-way (a restart, a hung model) release their hold and are marked failed, uncharged. */
export async function releaseStaleAnswers(db: Db, _keys: SigningKeys | null, cutoff: Date): Promise<number> {
  const stale = await db.answer.findMany({ where: { status: 'answering', createdAt: { lt: cutoff } }, select: { id: true, libraryId: true, account: { select: { ownerId: true } } } });
  let released = 0;
  for (const a of stale) {
    released += await db.$transaction(async (tx) => {
      // Same lock order as settle(): audit chain → account → answer.
      await lockAuditChain(tx);
      await lockAccount(tx, a.account.ownerId);
      await tx.$queryRaw`SELECT id FROM "Answer" WHERE id = ${a.id} FOR UPDATE`;
      const row = await tx.answer.findUnique({ where: { id: a.id }, select: { status: true, accountId: true, reservedCents: true } });
      if (!row || row.status !== 'answering') return 0;
      await tx.answer.update({ where: { id: a.id }, data: { status: 'failed', failureReason: 'Interrupted before it finished. You were not charged.', finishedAt: new Date() } });
      await tx.creditAccount.update({ where: { id: row.accountId }, data: { reservedCents: { decrement: row.reservedCents } } });
      await appendAudit(tx, { entityType: 'answer', entityId: a.id, tenantId: a.libraryId, eventType: 'answer.failed', payload: { chargedCents: 0, error: 'interrupted' } });
      return 1;
    });
  }
  return released;
}
