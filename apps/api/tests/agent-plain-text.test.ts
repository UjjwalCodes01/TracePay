import { describe, expect, it } from 'vitest';
import { plainText, stripMarkdown, titlesFrom } from '../src/modules/agent/plain-text';
import type { AgentMessage } from '../src/modules/agent/planners';

const WORLD = 'dw_k3j9x0aa2b7c_asset_northwind_index_v1';
const history: AgentMessage[] = [
  { role: 'user', text: 'Build the report.' },
  {
    role: 'tool',
    results: [
      { id: '1', name: 'find_approved_sources', response: { sources: [{ assetVersionId: WORLD, title: 'Northwind DevTools Spend Index 2026', owner: 'Northwind' }] } },
      { id: '2', name: 'find_compatible_replacement', response: { blockedAssetVersionId: 'asset_kestrel_panel_v1', blockedTitle: 'Kestrel Enterprise Engineering Panel 2026', candidates: [] } },
      { id: '3', name: 'search_reports', response: { reports: [{ reportId: 'cmh3x8q2k0001ab12cd34ef56', title: 'Developer Tools Market Brief', summary: 'x' }] } },
    ],
  },
];

describe('the agents’ words, as people read them', () => {
  it('takes titles only from the run’s own tool results, never other ids beside them', () => {
    const t = titlesFrom(history);
    expect(t.get(WORLD)).toBe('Northwind DevTools Spend Index 2026');
    expect(t.get('asset_kestrel_panel_v1')).toBe('Kestrel Enterprise Engineering Panel 2026');
    expect(t.get('cmh3x8q2k0001ab12cd34ef56')).toBe('Developer Tools Market Brief');
    expect(t.size).toBe(3);
  });

  it('names sources and reports by title, however the model wrote the id', () => {
    const t = titlesFrom(history);
    expect(plainText(`I replaced asset_kestrel_panel_v1 with ${WORLD}.`, t)).toBe('I replaced “Kestrel Enterprise Engineering Panel 2026” with “Northwind DevTools Spend Index 2026”.');
    expect(plainText(`Bought "cmh3x8q2k0001ab12cd34ef56".`, t)).toBe('Bought “Developer Tools Market Brief”.');
    // Title and id together: said once.
    expect(plainText(`Northwind DevTools Spend Index 2026 (${WORLD}) passed.`, t)).toBe('Northwind DevTools Spend Index 2026 passed.');
    // Part of a longer id is left alone.
    expect(plainText('Passage asset_kestrel_panel_v1_c3 was withheld.', t)).toBe('Passage asset_kestrel_panel_v1_c3 was withheld.');
  });

  it('turns markdown into plain text and keeps ids’ underscores', () => {
    expect(stripMarkdown('### Summary\n**Listed** at *$20.00*.\n- one\n* two\n\n\n`code` and [the store](https://x.test/store)')).toBe('Summary\nListed at $20.00.\n• one\n• two\n\ncode and the store');
    expect(stripMarkdown('Used asset_okafor_notes_v1 and __Kestrel__.')).toBe('Used asset_okafor_notes_v1 and Kestrel.');
    expect(stripMarkdown('2 * 3 = 6, and 4*5 too')).toBe('2 * 3 = 6, and 4*5 too');
  });
});
