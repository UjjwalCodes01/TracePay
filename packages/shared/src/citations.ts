/**
 * Citation markers are one handle per bracket: "[C5][C6]". Models sometimes group them —
 * "[C5, C6]" or "[C5; C6]" — which every parser would miss (unpaid, unrendered). This splits groups
 * into single markers; text without groups comes back unchanged.
 */
export function splitCitationGroups(text: string): string {
  return text.replace(/\[\s*(C\d+(?:\s*[,;]\s*C\d+)+)\s*\]/g, (_, group: string) =>
    group
      .split(/\s*[,;]\s*/)
      .map((h) => `[${h}]`)
      .join(''),
  );
}
