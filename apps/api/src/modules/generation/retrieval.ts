import type { Tx } from '../../db';
import type { RetrievedChunk } from './citations';

export interface RetrievedPassage extends RetrievedChunk {
  ordinal: number;
  text: string;
  rank: number;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'using', 'only', 'include', 'short']);

/** Turns a free-text brief into an OR-query of its significant words. */
export function briefToTsQuery(brief: string): string | null {
  const words = [...new Set(brief.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])]
    .map((w) => w.replace(/-/g, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 40);
  return words.length ? words.join(' | ') : null;
}

/**
 * Controlled retrieval: only chunks of the build's approved asset versions are
 * searchable, and each source contributes its top `perSource` passages. Handles
 * (C1, C2, ...) are assigned here and are the only references the model sees.
 */
export async function retrievePassages(
  tx: Tx,
  assetVersionIds: string[],
  brief: string,
  perSource = 3,
): Promise<RetrievedPassage[]> {
  if (assetVersionIds.length === 0) return [];
  const query = briefToTsQuery(brief) ?? 'report';

  const rows = await tx.$queryRaw<Array<{ id: string; assetVersionId: string; ordinal: number; text: string; rank: number }>>`
    SELECT id, "assetVersionId", ordinal, text, rank FROM (
      SELECT c.id, c."assetVersionId", c.ordinal, c.text,
             ts_rank(to_tsvector('english', c.text), to_tsquery('english', ${query}))::float8 AS rank,
             row_number() OVER (
               PARTITION BY c."assetVersionId"
               ORDER BY ts_rank(to_tsvector('english', c.text), to_tsquery('english', ${query})) DESC, c.ordinal
             ) AS rn
      FROM "SourceChunk" c
      WHERE c."assetVersionId" = ANY(${assetVersionIds}::text[]) AND c.ordinal > 0
    ) ranked
    WHERE rn <= ${perSource}
    ORDER BY array_position(${assetVersionIds}::text[], "assetVersionId"), rank DESC, ordinal`;

  return rows.map((r, i) => ({
    handle: `C${i + 1}`,
    chunkId: r.id,
    assetVersionId: r.assetVersionId,
    ordinal: r.ordinal,
    text: r.text,
    rank: Number(r.rank),
  }));
}
