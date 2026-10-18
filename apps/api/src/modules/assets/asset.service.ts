import type { Db } from '../../db';
import { appendAudit } from '../audit/audit-log';
import { sha256Hex } from '../audit/hash-chain';
import { chunkContent } from './chunk';

export const ASSET_KINDS = ['dataset', 'research_notes', 'expert_brief', 'api_feed'] as const;
export const MIN_CONTENT_CHARS = 80;
export const MAX_CONTENT_CHARS = 200_000;

export class AssetError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'invalid' | 'unchanged') {
    super(message);
    this.name = 'AssetError';
  }
}

function prepare(content: string) {
  const text = content.replace(/\r\n?/g, '\n').trim();
  if (text.length < MIN_CONTENT_CHARS) throw new AssetError(`Add at least ${MIN_CONTENT_CHARS} characters of content.`, 'invalid');
  if (text.length > MAX_CONTENT_CHARS) throw new AssetError(`Content is limited to ${MAX_CONTENT_CHARS.toLocaleString()} characters.`, 'invalid');
  const chunks = chunkContent(text);
  return { text, sha256: sha256Hex(text), chunks };
}

/** Registers a contributor's source with an immutable, fingerprinted first version. */
export async function createAsset(
  db: Db,
  ownerId: string,
  input: { title: string; kind: (typeof ASSET_KINDS)[number]; description: string; content: string },
) {
  const { text, sha256, chunks } = prepare(input.content);
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.create({ data: { ownerId, title: input.title.trim(), kind: input.kind, description: input.description.trim() } });
    const version = await tx.assetVersion.create({ data: { assetId: asset.id, version: 1, sha256, content: text } });
    await tx.sourceChunk.createMany({ data: chunks.map((t, ordinal) => ({ assetVersionId: version.id, ordinal, text: t })) });
    await appendAudit(tx, { entityType: 'asset', entityId: asset.id, eventType: 'asset.registered', payload: { version: 1, sha256, chunks: chunks.length }, tenantId: null });
    return { asset, version, chunks: chunks.length };
  });
}

/**
 * Adds a new version. Earlier versions are never modified, so reports already
 * built keep pointing at exactly what they used.
 */
export async function addVersion(db: Db, ownerId: string, assetId: string, content: string) {
  const { text, sha256, chunks } = prepare(content);
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.findUnique({ where: { id: assetId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!asset || asset.ownerId !== ownerId) throw new AssetError('Source not found.', 'not_found');
    const latest = asset.versions[0];
    if (latest?.sha256 === sha256) throw new AssetError('This content is identical to the current version.', 'unchanged');
    const version = await tx.assetVersion.create({ data: { assetId, version: (latest?.version ?? 0) + 1, sha256, content: text } });
    await tx.sourceChunk.createMany({ data: chunks.map((t, ordinal) => ({ assetVersionId: version.id, ordinal, text: t })) });
    await appendAudit(tx, { entityType: 'asset', entityId: assetId, eventType: 'asset.version_added', payload: { version: version.version, sha256, chunks: chunks.length }, tenantId: null });
    return { version, chunks: chunks.length };
  });
}
