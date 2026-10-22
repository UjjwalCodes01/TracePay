import type { BuildIntent, LicenseTerms, PreflightReport } from '@tracepay/shared';

export type Role = 'publisher' | 'contributor' | 'buyer' | 'admin';

export interface DemoUser {
  id: string;
  name: string;
  role: Role;
  email: string;
}

export interface AppConfig {
  paypalEnv: 'sandbox';
  paypalClientId: string | null;
  generation: 'vertex' | 'fixture';
  agentPlanner: 'gemini' | 'rule-based';
  vertexReady: boolean;
  demoMode: boolean;
  /** Demo mode only: which PayPal sandbox buyer account to pay with. */
  sandboxBuyerHint?: string | null;
  /** A hosted demo shares one buyer among every visitor: it may buy a report again. */
  demoSharedBuyer?: boolean;
}

export interface CatalogEntry {
  assetId: string;
  assetTitle: string;
  kind: string;
  description: string;
  owner: { id: string; name: string };
  assetVersionId: string;
  version: number;
  sha256: string;
  chunkCount: number;
  license: { id: string; version: number; status: string; terms: LicenseTerms; termsHash: string; sourceText: string | null } | null;
  pending: { id: string; version: number; status: string; terms: LicenseTerms | null } | null;
}

export interface PreflightOutcome {
  buildId: string;
  report: PreflightReport;
  snapshotHash: string;
}

export interface Explanation {
  verdict: 'pass' | 'block';
  headline: string;
  explanation: string;
  suggestedFix: string | null;
  source: 'vertex' | 'rules';
}

export interface Section {
  key: string;
  heading: string;
  body: string;
  requiresCitation: boolean;
}

export interface ArtifactContent {
  title: string;
  sections: Section[];
  credits: Array<{ assetVersionId: string; assetTitle: string; text: string }>;
  sources: Array<{ assetVersionId: string; assetTitle: string; version: number; sha256: string; cited: boolean }>;
}

export interface CitationReport {
  ok: boolean;
  citations: Array<{ sectionKey: string; handle: string; chunkId: string; assetVersionId: string }>;
  citedAssetVersionIds: string[];
  retrievedNotCitedAssetVersionIds: string[];
}

export interface ArtifactPreview {
  id: string;
  title: string;
  priceCents: number;
  currency: string;
  status: string;
  model: string;
  fromFixture: boolean;
  contentHash: string;
  createdAt: string;
  summary: string | null;
  sectionHeadings: string[];
  sources: Array<{ title: string; cited: boolean }>;
  credits: string[];
}

export interface ArtifactFull extends ArtifactPreview {
  content: ArtifactContent;
  citationReport: CitationReport;
  purchased: boolean;
}

export type Evidence = 'verified' | 'recorded' | 'ai_interpretation' | 'contractual';

export interface ProvNode {
  id: string;
  kind: 'source' | 'passage' | 'section' | 'artifact' | 'sale' | 'settlement_line' | 'payout';
  label: string;
  evidence: Evidence;
  data: Record<string, unknown>;
}

export interface ProvEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  evidence: Evidence;
}

export interface AgentStep {
  id: string;
  ordinal: number;
  kind: 'plan' | 'tool_call' | 'tool_result' | 'approval_request' | 'message' | 'error';
  tool: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  goal: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed';
  model: string;
  intent: BuildIntent;
  selection: string[];
  pending: { blockedAssetVersionId: string; replacementAssetVersionId: string; reason: string } | null;
  summary: string | null;
  steps: AgentStep[];
  builds: Array<{ id: string; status: string; artifact: { id: string } | null }>;
}

export interface PayoutItem {
  id: string;
  status: string;
  receiver: string;
  amountCents: number;
  paypalItemId: string | null;
  transactionId: string | null;
  errorName: string | null;
}

export interface SettlementLine {
  id: string;
  kind: 'contributor' | 'publisher_residual';
  recipientId: string;
  payeeEmail: string | null;
  licenseGrantId: string | null;
  assetVersionId: string | null;
  amountCents: number;
  formula: string;
  payable: boolean;
  note: string | null;
  payoutItem: PayoutItem | null;
}

export interface SettlementRun {
  id: string;
  saleId: string;
  status: 'calculated' | 'approved' | 'payout_submitted' | 'completed' | 'exception';
  grossCents: number;
  contributorTotalCents: number;
  publisherResidualCents: number;
  roundingRule: string;
  snapshotHash: string;
  approvedAt: string | null;
  createdAt: string;
  lines: SettlementLine[];
  /** Payout attempts, newest first. */
  batches: Array<{ attempt: number; senderBatchId: string; paypalBatchId: string | null; status: string; lastCheckedAt: string | null }>;
  failureReason: string | null;
  sale: {
    id: string;
    status: string;
    amountCents: number;
    payment: { orderId: string; captureId: string | null; captureStatus: string | null; capturedCents: number | null; paypalFeeCents: number | null } | null;
    artifact: { id: string; title: string; buildJobId: string };
  };
}

export interface Dashboard {
  licenseOffers: number;
  settlementsToApprove: number;
  settlementsToPay: number;
  payoutsInProgress: number;
  agentWaiting: number;
  latestArtifact: { id: string; title: string } | null;
  buildsPassed: number;
  buildsBlocked: number;
  artifacts: number;
  verifiedSales: number;
  verifiedSalesCents: number;
  unsettledContributorCents: number;
  paidOutCents: number;
  payoutsCompleted: number;
  exceptions: number;
  recentEvents: Array<{ seq: number; eventType: string; entityType: string; entityId: string; createdAt: string; hash: string; payload: Record<string, unknown> | null }>;
}

export interface SignedReceipt {
  document: Record<string, unknown> & {
    receiptVersion: string;
    view: 'owner' | 'buyer' | 'contributor';
    issuedAt: string;
    artifact: { id: string; title: string; contentHash: string; model: string; fromFixture: boolean; priceCents: number; credits: string[] };
    rights: { buildId: string; asOf: string; snapshotHash: string; preflight: { verdict: string; rulesEvaluated: number; failed: string[]; obligations: string[]; policyVersion: string } };
    sources: Array<{ assetVersionId: string; title: string; owner: string; version: number; sha256: string; licenseId: string | null; cited: boolean }>;
    sales: Array<{
      saleId: string;
      status: string;
      paypal: { orderId: string; captureId: string; captureStatus: string; capturedCents: number };
      settlement: null | {
        runId: string;
        status: string;
        grossCents: number;
        roundingRule: string;
        lines: Array<{ kind: string; recipientId: string; licenseId: string | null; amountCents: number; formula: string; payout: { status: string; paypalItemId: string | null; transactionId: string | null } | null }>;
        payoutBatches: Array<{ attempt: number; senderBatchId: string; paypalBatchId: string | null; status: string }>;
      };
    }>;
    auditTrail: Array<{ seq: number; eventType: string; at: string; hash: string }>;
    chain: { verified: boolean; headSeq: number | null; headHash: string | null };
    disclaimer: string;
  };
  signature: string;
  algorithm: 'Ed25519';
  publicKeyPem: string;
}
