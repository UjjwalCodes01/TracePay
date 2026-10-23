import { describe, expect, it } from 'vitest';
import { auditAnswer, citationPairs, supports } from '../src/modules/answers/integrity';
import { RuleSupportJudge } from '../src/modules/answers/support';

/** The deterministic support rule (no AI): pays for a passage's specific content, not its topic. */
const PASSAGE = 'Teams with an AI coding assistant shipped 38% more pull requests per engineer in Q3.';
const CORPUS = [
  PASSAGE,
  'Spend on developer tools rose to $1,940 per engineer, led by observability and testing.',
  'Senior engineers distrust generated code in security-sensitive modules and review it line by line.',
  'Survey respondents rank onboarding speed above price when choosing a coding assistant.',
];
const TOPIC = 'How do AI coding assistants change engineering teams?';
const rule = (sentence: string) => supports(sentence, PASSAGE, { corpus: CORPUS, topic: TOPIC });

describe('citation support without AI', () => {
  it('doesn’t pay for sentences that only share the topic', () => {
    expect(rule('Assistant teams love coding at night.')).toBe(false);
    expect(rule('Coding assistants are popular with engineers.')).toBe(false);
    expect(rule('The weather in Lisbon was pleasant all autumn.')).toBe(false);
  });

  it('pays for the passage’s specific figures and terms', () => {
    expect(rule('Teams using an AI coding assistant shipped 38% more pull requests.')).toBe(true);
    expect(rule('Pull requests per engineer rose sharply after teams adopted assistants.')).toBe(true);
  });

  it('feeds verdicts from a judge into who is paid, and explains each one', async () => {
    const passages = [{ handle: 'C1', chunkId: 'p1', assetVersionId: 'a', text: PASSAGE }];
    const text = 'Teams shipped 38% more pull requests [C1]. Assistant teams love coding at night [C1].';
    const pairs = citationPairs(text, passages);
    expect(pairs.map((p) => p.sentence)).toEqual(['Teams shipped 38% more pull requests.', 'Assistant teams love coding at night.']);
    const verdicts = await new RuleSupportJudge().judge(pairs, { corpus: CORPUS, topic: TOPIC });
    const audit = auditAnswer(text, passages, [{ assetVersionId: 'a', centsPerCitation: 2 }], { verdicts, topic: TOPIC });
    expect(audit.contributorCents).toBe(2);
    expect(audit.ignored.unsupported).toBe(1);
    expect(audit.citations.map((c) => [c.supported, c.reason])).toEqual([
      [true, 'Shares specific terms or figures with the passage.'],
      [false, 'Shares no specific terms or figures with the passage.'],
    ]);
  });
});
