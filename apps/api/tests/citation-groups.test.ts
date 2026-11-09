import { splitCitationGroups } from '@tracepay/shared';
import { describe, expect, it } from 'vitest';
import { citationPairs } from '../src/modules/answers/integrity';

describe('grouped citation markers', () => {
  it('splits "[C5, C6]" and "[C5; C6]" into one marker per bracket, and leaves the rest alone', () => {
    expect(splitCitationGroups('Concerns remain [C5, C6].')).toBe('Concerns remain [C5][C6].');
    expect(splitCitationGroups('Both [ C1 ;C2; C3 ] agree.')).toBe('Both [C1][C2][C3] agree.');
    expect(splitCitationGroups('One source [C4], then [C2][C3].')).toBe('One source [C4], then [C2][C3].');
    expect(splitCitationGroups('A footnote [see C5, C6] is not a citation group.')).toBe('A footnote [see C5, C6] is not a citation group.');
  });

  it('so both sources of a grouped citation reach the judge, and get paid', () => {
    const passages = ['C5', 'C6'].map((handle) => ({ handle, chunkId: handle, assetVersionId: handle, text: `${handle} text` }));
    expect(citationPairs('Concerns remain [C5, C6].', passages)).toHaveLength(0);
    expect(citationPairs(splitCitationGroups('Concerns remain [C5, C6].'), passages).map((p) => p.passage)).toEqual(['C5 text', 'C6 text']);
  });
});
