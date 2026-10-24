import type { BuildIntent, PreflightReport } from '@tracepay/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../db';
import { appendAudit } from '../audit/audit-log';
import { canonicalJson, sha256Hex } from '../audit/hash-chain';
import { resolveSources } from '../catalog/catalog.service';
import { failedRules, runPreflight } from '../license-compiler/compiler';

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export interface PreflightRequest {
  publisherId: string;
  intent: BuildIntent;
  assetVersionIds: string[];
  agentRunId?: string | null;
  asOf?: string;
  /** A demo's ready-made sample report (see demo/sample-report). */
  sample?: boolean;
}

export interface PreflightOutcome {
  buildId: string;
  report: PreflightReport;
  snapshotHash: string;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Runs the license compiler and records the attempt — passing or blocked — as
 * a BuildJob. The license terms in force right now are frozen onto the build,
 * so a later license edit can never rewrite this build's settlement.
 */
export async function preflightAndRecord(tx: Tx, req: PreflightRequest): Promise<PreflightOutcome> {
  const asOf = req.asOf ?? todayUtc();
  const sources = await resolveSources(tx, req.publisherId, req.assetVersionIds);
  const report = runPreflight({ intent: req.intent, sources, asOf });

  const snapshot = {
    policyVersion: report.policyVersion,
    asOf,
    intent: req.intent,
    sources: sources.map((s) => ({
      assetVersionId: s.assetVersionId,
      licenseId: s.license?.id ?? null,
      termsHash: s.termsHash,
      payeeEmail: s.payeeEmail,
    })),
  };
  const snapshotHash = sha256Hex(canonicalJson(snapshot));

  const build = await tx.buildJob.create({
    data: {
      publisherId: req.publisherId,
      agentRunId: req.agentRunId ?? null,
      sample: req.sample ?? false,
      intent: json(req.intent),
      asOf,
      status: report.verdict === 'pass' ? 'preflight_passed' : 'preflight_blocked',
      preflight: json(report),
      policyVersion: report.policyVersion,
      snapshotHash,
      sources: {
        create: sources.map((s, ordinal) => ({
          ordinal,
          assetVersionId: s.assetVersionId,
          licenseGrantId: s.license?.id ?? null,
          termsSnapshot: s.license
            ? json({ ...s.license.terms, licenseId: s.license.id, termsHash: s.termsHash, contributorId: s.contributorId, assetTitle: s.assetTitle })
            : undefined,
          payeeEmail: s.payeeEmail,
        })),
      },
    },
  });

  await appendAudit(tx, {
    entityType: 'build',
    entityId: build.id,
    eventType: report.verdict === 'pass' ? 'build.preflight_passed' : 'build.preflight_blocked',
    payload: {
      snapshotHash,
      asOf,
      assetVersionIds: req.assetVersionIds,
      failedRules: failedRules(report).map((r) => ({ ruleId: r.ruleId, assetVersionId: r.assetVersionId ?? null })),
    },
  });

  return { buildId: build.id, report, snapshotHash };
}
