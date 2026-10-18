import type { BuildIntent, PreflightReport } from '@tracepay/shared';
import type { Tx } from '../../db';
import { appendAudit } from '../audit/audit-log';
import { canonicalJson, sha256Hex } from '../audit/hash-chain';
import { todayUtc } from '../builds/preflight.service';
import { resolveSources } from '../catalog/catalog.service';
import { failedRules, runPreflight } from '../license-compiler/compiler';

/** One source's terms as they stood at the moment of sale. */
export interface SaleTerm {
  assetVersionId: string;
  assetTitle: string;
  licenseId: string;
  termsHash: string | null;
  contributorId: string;
  payeeEmail: string | null;
  economics: unknown;
  payableOn: string;
}

export type SaleRights =
  | { ok: true; report: PreflightReport; snapshot: SaleTerm[]; snapshotHash: string }
  /** `permanent` false = the problem may clear by itself (e.g. a payout address being updated). */
  | { ok: false; report: PreflightReport; reasons: string[]; permanent: boolean };

/** Failures that don't mean the license itself stopped permitting the sale. */
const TRANSIENT_RULES = new Set(['PAYEE_DEFINED']);

/**
 * Licenses can be revoked, expire or be renegotiated after a report is built.
 * Before every sale the compiler re-runs on the report's pinned sources with
 * the licenses in force TODAY; the sale is allowed only if they still permit it,
 * and those exact terms are frozen onto the sale for its settlement.
 */
export async function checkSaleRights(tx: Tx, artifactId: string, asOf = todayUtc()): Promise<SaleRights> {
  const artifact = await tx.artifact.findUniqueOrThrow({
    where: { id: artifactId },
    include: { buildJob: { include: { sources: { orderBy: { ordinal: 'asc' } } } } },
  });
  const intent = artifact.buildJob.intent as unknown as BuildIntent;
  const sources = await resolveSources(tx, artifact.buildJob.publisherId, artifact.buildJob.sources.map((s) => s.assetVersionId));
  const report = runPreflight({ intent, sources, asOf });
  if (report.verdict === 'block') {
    const failed = failedRules(report);
    return { ok: false, report, reasons: failed.map((r) => r.message), permanent: failed.some((r) => !TRANSIENT_RULES.has(r.ruleId)) };
  }

  // Credits were fixed when the report was written. If renegotiated terms now
  // require attribution the report doesn't carry, it can't be sold as-is.
  const credits = ((artifact.content as { credits?: Array<{ assetVersionId: string; text: string }> }).credits ?? []);
  const missing = report.obligations.filter((o) => !credits.some((c) => c.assetVersionId === o.assetVersionId && c.text === o.text));
  if (missing.length) {
    return {
      ok: false,
      report,
      reasons: missing.map((o) => `"${o.assetTitle}" now requires the credit "${o.text}", which this report doesn't include. Rebuild the report.`),
      permanent: true,
    };
  }

  const snapshot: SaleTerm[] = sources.map((s) => ({
    assetVersionId: s.assetVersionId,
    assetTitle: s.assetTitle,
    licenseId: s.license!.id,
    termsHash: s.termsHash,
    contributorId: s.contributorId,
    payeeEmail: s.payeeEmail,
    economics: s.license!.terms.economics,
    payableOn: s.license!.terms.payableOn,
  }));
  return { ok: true, report, snapshot, snapshotHash: sha256Hex(canonicalJson({ asOf, snapshot })) };
}

/** Takes a report off sale, recording why. No-op if it isn't listed. */
export async function withdrawArtifact(tx: Tx, artifactId: string, reasons: string[], by: 'system' | 'publisher') {
  const res = await tx.artifact.updateMany({ where: { id: artifactId, status: 'listed' }, data: { status: 'withdrawn' } });
  if (res.count === 0) return false;
  await appendAudit(tx, { entityType: 'artifact', entityId: artifactId, artifactId, eventType: 'artifact.withdrawn', payload: { by, reasons } });
  return true;
}

/** When a license is revoked, every listed report of that licensee using the source stops selling. */
export async function withdrawReportsUsingAsset(tx: Tx, assetId: string, publisherId: string, reason: string): Promise<string[]> {
  const affected = await tx.artifact.findMany({
    where: { status: 'listed', buildJob: { publisherId, sources: { some: { assetVersion: { assetId } } } } },
    select: { id: true },
  });
  for (const a of affected) await withdrawArtifact(tx, a.id, [reason], 'system');
  return affected.map((a) => a.id);
}
