import { describe, expect, it } from 'vitest';
import { progressReporter, readProgress } from '../src/modules/answers/progress';

describe('answer progress', () => {
  it('records each stage once, in order, for its own asker only', () => {
    const id = 'p_0123456789abcdef';
    const report = progressReporter('buyer_a', id);
    report('rights');
    report('retrieval');
    report('retrieval');
    report('writing');
    expect(readProgress('buyer_a', id)!.stages.map((s) => s.stage)).toEqual(['rights', 'retrieval', 'writing']);
    expect(readProgress('buyer_b', id)).toBeNull();
    // Another asker can't take over an id in use.
    progressReporter('buyer_b', id)('settling');
    expect(readProgress('buyer_a', id)!.stages.at(-1)!.stage).toBe('writing');
  });

  it('ignores a missing or malformed id', () => {
    expect(() => progressReporter('buyer_a')('rights')).not.toThrow();
    progressReporter('buyer_a', 'short')('rights');
    expect(readProgress('buyer_a', 'short')).toBeNull();
    expect(readProgress('buyer_a', 'never_seen_0123456789')).toBeNull();
  });
});
