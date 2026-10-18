import type { LicenseTerms, PreflightReport } from '@tracepay/shared';
import type { Tx } from '../../db';
import type { ArtifactContent } from '../generation/generation.service';

/**
 * How much an element of the graph can be trusted. Keeping these apart is
 * the point: an AI's claim that a passage supports a sentence is not the same
 * kind of fact as PayPal confirming a capture.
 */
export type Evidence = 'verified' | 'recorded' | 'ai_interpretation' | 'contractual';

export type NodeKind = 'source' | 'passage' | 'section' | 'artifact' | 'sale' | 'settlement_line' | 'payout';

export interface ProvNode {
  id: string;
  kind: NodeKind;
  label: string;
  evidence: Evidence;
  data: Record<string, unknown>;
}

export type EdgeKind = 'contains' | 'retrieved_for' | 'supports_claim' | 'included_in' | 'sold_as' | 'allocated_to' | 'paid_via';

export interface ProvEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  evidence: Evidence;
}

export interface ProvenanceGraph {
  artifactId: string;
  nodes: ProvNode[];
  edges: ProvEdge[];
}

export async function getProvenance(tx: Tx, artifactId: string): Promise<ProvenanceGraph | null> {
  const artifact = await tx.artifact.findUnique({
    where: { id: artifactId },
    include: {
      citations: true,
      buildJob: {
        include: {
          sources: { orderBy: { ordinal: 'asc' }, include: { assetVersion: { include: { asset: { include: { owner: true } } } } } },
          events: { where: { eventType: 'retrieved' }, include: { chunk: true }, orderBy: { handle: 'asc' } },
        },
      },
      sales: {
        orderBy: { createdAt: 'asc' },
        include: { payment: true, settlement: { include: { lines: { include: { payoutItem: true } } } } },
      },
    },
  });
  if (!artifact) return null;

  const content = artifact.content as unknown as ArtifactContent;
  const nodes: ProvNode[] = [];
  const edges: ProvEdge[] = [];
  const edge = (source: string, target: string, kind: EdgeKind, evidence: Evidence) =>
    edges.push({ id: `${kind}:${source}->${target}`, source, target, kind, evidence });

  const artifactNode = `artifact:${artifact.id}`;
  nodes.push({
    id: artifactNode,
    kind: 'artifact',
    label: artifact.title,
    evidence: 'recorded',
    data: {
      artifactId: artifact.id,
      contentHash: artifact.contentHash,
      model: artifact.model,
      fromFixture: artifact.fromFixture,
      priceCents: artifact.priceCents,
      buildId: artifact.buildJobId,
      buildSnapshotHash: artifact.buildJob.snapshotHash,
    },
  });

  for (const s of artifact.buildJob.sources) {
    const terms = s.termsSnapshot as unknown as (LicenseTerms & { licenseId: string }) | null;
    nodes.push({
      id: `source:${s.assetVersionId}`,
      kind: 'source',
      label: s.assetVersion.asset.title,
      evidence: 'contractual',
      data: {
        assetVersionId: s.assetVersionId,
        version: s.assetVersion.version,
        sha256: s.assetVersion.sha256,
        owner: s.assetVersion.asset.owner.name,
        licenseId: terms?.licenseId ?? null,
        economics: terms?.economics ?? null,
        payableOn: terms?.payableOn ?? null,
        cited: content.sources.find((x) => x.assetVersionId === s.assetVersionId)?.cited ?? false,
      },
    });
  }

  for (const e of artifact.buildJob.events) {
    const id = `passage:${e.chunkId}`;
    nodes.push({
      id,
      kind: 'passage',
      label: `[${e.handle}] ${e.chunk.text.slice(0, 80)}${e.chunk.text.length > 80 ? '…' : ''}`,
      evidence: 'recorded',
      data: { chunkId: e.chunkId, handle: e.handle, text: e.chunk.text, retrievedAt: e.createdAt },
    });
    edge(`source:${e.assetVersionId}`, id, 'contains', 'recorded');
  }

  for (const sec of content.sections) {
    const id = `section:${sec.key}`;
    nodes.push({ id, kind: 'section', label: sec.heading, evidence: 'ai_interpretation', data: { key: sec.key, body: sec.body } });
    edge(id, artifactNode, 'included_in', 'recorded');
  }
  for (const c of artifact.citations) {
    edge(`passage:${c.chunkId}`, `section:${c.sectionKey}`, 'supports_claim', 'ai_interpretation');
  }

  for (const sale of artifact.sales) {
    if (!sale.payment?.captureId) continue;
    const saleNode = `sale:${sale.id}`;
    nodes.push({
      id: saleNode,
      kind: 'sale',
      label: `Sale ${sale.status}`,
      evidence: 'verified',
      data: {
        saleId: sale.id,
        status: sale.status,
        orderId: sale.payment.orderId,
        captureId: sale.payment.captureId,
        captureStatus: sale.payment.captureStatus,
        capturedCents: sale.payment.capturedCents,
      },
    });
    edge(artifactNode, saleNode, 'sold_as', 'verified');

    for (const line of sale.settlement?.lines ?? []) {
      const lineNode = `line:${line.id}`;
      nodes.push({
        id: lineNode,
        kind: 'settlement_line',
        label: `${line.kind === 'publisher_residual' ? 'Publisher' : 'Royalty'} ${(line.amountCents / 100).toFixed(2)}`,
        evidence: 'contractual',
        data: { lineId: line.id, recipientId: line.recipientId, amountCents: line.amountCents, formula: line.formula, payable: line.payable, note: line.note, licenseId: line.licenseGrantId },
      });
      edge(saleNode, lineNode, 'allocated_to', 'contractual');
      if (line.assetVersionId) edge(`source:${line.assetVersionId}`, lineNode, 'allocated_to', 'contractual');
      if (line.payoutItem) {
        const payoutNode = `payout:${line.payoutItem.id}`;
        nodes.push({
          id: payoutNode,
          kind: 'payout',
          label: `Payout ${line.payoutItem.status}`,
          evidence: 'verified',
          data: { status: line.payoutItem.status, receiver: line.payoutItem.receiver, paypalItemId: line.payoutItem.paypalItemId, transactionId: line.payoutItem.transactionId },
        });
        edge(lineNode, payoutNode, 'paid_via', 'verified');
      }
    }
  }

  return { artifactId, nodes, edges };
}

/** Exported for receipts: the preflight result stored on a build. */
export function preflightSummary(report: PreflightReport) {
  return {
    policyVersion: report.policyVersion,
    verdict: report.verdict,
    rulesEvaluated: report.results.filter((r) => r.outcome !== 'skip').length,
    failed: report.results.filter((r) => r.outcome === 'fail').map((r) => r.ruleId),
    obligations: report.obligations.map((o) => o.text),
  };
}
