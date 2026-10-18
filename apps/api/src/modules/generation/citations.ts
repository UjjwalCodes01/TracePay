/**
 * Citation validation. The model only ever sees short handles (C1, C2, ...)
 * for chunks the retrieval step actually returned. Anything it cites is
 * mapped back through that table; an unknown handle is a hallucinated source.
 */

export interface RetrievedChunk {
  handle: string;
  chunkId: string;
  assetVersionId: string;
}

export interface DraftSection {
  key: string;
  heading: string;
  body: string;
  /** Findings must be grounded; framing sections (e.g. outlook) may not be. */
  requiresCitation: boolean;
}

export interface ResolvedCitation {
  sectionKey: string;
  handle: string;
  chunkId: string;
  assetVersionId: string;
}

export interface CitationError {
  sectionKey: string;
  reason: 'unknown_reference' | 'missing_citation';
  handle?: string;
  message: string;
}

export interface CitationReport {
  ok: boolean;
  citations: ResolvedCitation[];
  errors: CitationError[];
  citedAssetVersionIds: string[];
  /** Sources retrieved during generation that the final text never cites. */
  retrievedNotCitedAssetVersionIds: string[];
}

const MARKER = /\[(C\d+)\]/g;

export function extractHandles(body: string): string[] {
  return [...new Set([...body.matchAll(MARKER)].map((m) => m[1]!))];
}

export function validateCitations(sections: DraftSection[], retrieved: RetrievedChunk[]): CitationReport {
  const byHandle = new Map(retrieved.map((c) => [c.handle, c]));
  const citations: ResolvedCitation[] = [];
  const errors: CitationError[] = [];

  for (const section of sections) {
    const handles = extractHandles(section.body);
    if (section.requiresCitation && handles.length === 0) {
      errors.push({
        sectionKey: section.key,
        reason: 'missing_citation',
        message: `Section "${section.heading}" makes claims without citing any retrieved source.`,
      });
    }
    for (const handle of handles) {
      const chunk = byHandle.get(handle);
      if (!chunk) {
        errors.push({
          sectionKey: section.key,
          reason: 'unknown_reference',
          handle,
          message: `Section "${section.heading}" cites [${handle}], which was never retrieved.`,
        });
        continue;
      }
      citations.push({ sectionKey: section.key, handle, chunkId: chunk.chunkId, assetVersionId: chunk.assetVersionId });
    }
  }

  const cited = new Set(citations.map((c) => c.assetVersionId));
  const retrievedAssets = new Set(retrieved.map((c) => c.assetVersionId));

  return {
    ok: errors.length === 0,
    citations,
    errors,
    citedAssetVersionIds: [...cited].sort(),
    retrievedNotCitedAssetVersionIds: [...retrievedAssets].filter((a) => !cited.has(a)).sort(),
  };
}
