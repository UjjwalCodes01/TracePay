import type { BuildIntent } from '@tracepay/shared';
import type { Db } from '../../db';
import { logger } from '../../http/logger';
import { preflightAndRecord } from '../builds/preflight.service';
import { generateArtifact } from '../generation/generation.service';
import type { ReportWriter } from '../generation/writers';
import { DEMO_IDS, inWorld } from './world';

/**
 * A report already for sale in every new (or reset) demo world, so a buyer who looks first doesn't
 * find an empty store. It is built exactly as the publisher would build one — license check,
 * licensed passages only, every claim cited, listed — in the background: the world opens at once
 * and the report appears a few seconds later. Its sources all pass the license check, so the
 * blocked-source story stays for the visitor to see, and it doesn't count as the publisher's own
 * progress on the dashboard.
 */

export const SAMPLE_INTENT: BuildIntent = {
  title: 'AI Coding Assistants: Spend and Adoption Snapshot (sample)',
  brief: 'How fast spending on AI coding assistants is growing, how many developers use one weekly, and what makes teams renew.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includesRawData: false,
  territory: 'US',
  priceCents: 1500,
  currency: 'USD',
};

export const SAMPLE_SOURCES = ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'];

/** Builds and lists the world's sample report; the new report's id, or null if it couldn't be. */
export async function buildSampleReport(db: Db, world: string | null, writer: ReportWriter): Promise<string | null> {
  const outcome = await db.$transaction((tx) =>
    preflightAndRecord(tx, { publisherId: inWorld(world, DEMO_IDS.publisher), intent: SAMPLE_INTENT, assetVersionIds: SAMPLE_SOURCES.map((id) => inWorld(world, id)), sample: true }),
  );
  if (outcome.report.verdict !== 'pass') {
    logger.warn({ world, buildId: outcome.buildId }, 'the sample report’s sources no longer pass the license check');
    return null;
  }
  return (await generateArtifact(db, outcome.buildId, writer)).artifactId;
}

/** The same, without holding up the caller; a failure only means the store starts empty. */
export function buildSampleReportLater(db: Db, world: string | null, writer: ReportWriter): void {
  void buildSampleReport(db, world, writer).catch((err) => logger.warn({ err: (err as Error).message, world }, 'sample report not built'));
}
