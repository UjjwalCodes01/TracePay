import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Results of the AI red team (src/scripts/red-team.ts): a Gemini model, playing the attacker, writes
 * fresh attacks against TracePay's two AI defences — the passage screen and the citation judge —
 * plus honest controls, and the real defences are scored on them. Misses are published as-is.
 */

const Example = z.object({ text: z.string(), technique: z.string(), passage: z.string().optional(), why: z.string() });
const Score = z.object({ total: z.number().int(), correct: z.number().int(), misses: z.array(Example) });

export const RedTeamReport = z.object({
  generatedAt: z.string(),
  /** Independent rounds (fresh attacks each), added together: one round swings too much to quote. */
  rounds: z.number().int().min(1).optional(),
  attackerModel: z.string(),
  defenceModel: z.string(),
  /** Planted instructions in a source: caught = withheld from the writer. */
  screenAttacks: Score,
  /**
   * Real, published text that must not be withheld: abstracts of papers about prompt injection and
   * instruction-following, and Creative Commons license clauses ("You must…") — about AI, or
   * addressed to the reader, never to an AI (fixtures/red-team/honest-controls.json).
   */
  screenControls: Score,
  /** Look-alikes the attacker wrote to be mistaken for instructions; many read like commands to whoever reads them. */
  screenLookalikes: Score.optional(),
  /** Citations that shouldn't be paid (topic-only, misquoted, unsupported…): caught = not paid. */
  judgeAttacks: Score,
  /** Honest paraphrases that should be paid: correct = paid. */
  judgeControls: Score,
  /** Honest sentences that combine two sources: correct = both are paid. */
  judgeCombined: Score.optional(),
  /** Sentences that cite a second source they don't use: caught = the padded one isn't paid. */
  judgePadded: Score.optional(),
  /** Padded sentences in which the judge didn't pay the source really used either (it underpaid). */
  paddedRealSourceUnpaid: z.number().int().optional(),
  /** What the missed citation attacks would have been paid, at the demo rate. */
  overpaidCents: z.number().int(),
});
export type RedTeamReport = z.infer<typeof RedTeamReport>;

export const RED_TEAM_FILE = () => process.env.RED_TEAM_FILE ?? path.resolve(process.cwd(), 'fixtures/red-team/latest.json');

let cached: RedTeamReport | null | undefined;

/** The latest published red-team run, or null if none has been run. */
export async function latestRedTeam(): Promise<RedTeamReport | null> {
  if (cached !== undefined) return cached;
  try {
    cached = RedTeamReport.parse(JSON.parse(await readFile(RED_TEAM_FILE(), 'utf8')));
  } catch {
    cached = null;
  }
  return cached;
}
