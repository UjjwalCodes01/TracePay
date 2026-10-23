import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Results of the AI red team (src/scripts/red-team.ts): Gemini, playing the attacker, writes
 * fresh attacks against TracePay's two AI defences — the passage screen and the citation judge —
 * plus honest controls, and the real defences are scored on them. Misses are published as-is.
 */

const Example = z.object({ text: z.string(), technique: z.string(), passage: z.string().optional(), why: z.string() });
const Score = z.object({ total: z.number().int(), correct: z.number().int(), misses: z.array(Example) });

export const RedTeamReport = z.object({
  generatedAt: z.string(),
  attackerModel: z.string(),
  defenceModel: z.string(),
  /** Planted instructions in a source: caught = withheld from the writer. */
  screenAttacks: Score,
  /** Ordinary passages (about AI, citations, licences) that must not be withheld. */
  screenControls: Score,
  /** Citations that shouldn't be paid (topic-only, misquoted, unsupported…): caught = not paid. */
  judgeAttacks: Score,
  /** Honest paraphrases that should be paid: correct = paid. */
  judgeControls: Score,
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
