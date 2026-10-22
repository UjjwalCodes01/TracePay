import { z } from 'zod';
import type { PreflightReport } from '@tracepay/shared';
import { generateStructured } from '../../integrations/ai/vertex';
import { failedRules } from '../license-compiler/compiler';

const ExplanationSchema = z.object({
  headline: z.string().min(5).max(200),
  explanation: z.string().min(10).max(1200),
  suggestedFix: z.string().min(5).max(600),
});

export interface Explanation {
  verdict: 'pass' | 'block';
  headline: string;
  explanation: string;
  suggestedFix: string | null;
  source: 'vertex' | 'rules';
}

/**
 * Turns failed compiler rules into plain language. The model receives the
 * already-made decision and may only explain it — the verdict returned is
 * always the compiler's, never the model's.
 */
export async function explainPreflight(report: PreflightReport, useModel: boolean): Promise<Explanation> {
  const failed = failedRules(report);
  if (report.verdict === 'pass') {
    return {
      verdict: 'pass',
      headline: 'Every source you chose is licensed for this report.',
      explanation: report.obligations.length ? `The report must credit: ${report.obligations.map((o) => `"${o.text}"`).join('; ')}.` : 'No credit lines are needed.',
      suggestedFix: null,
      source: 'rules',
    };
  }

  const fallback: Explanation = {
    verdict: 'block',
    headline: `Stopped by ${failed.length} license check${failed.length === 1 ? '' : 's'}.`,
    explanation: failed.map((f) => f.message).join(' '),
    suggestedFix: 'Swap the blocked source for one whose license allows this use, or change how the report will be used.',
    source: 'rules',
  };
  if (!useModel) return fallback;

  try {
    const { data } = await generateStructured({
      system:
        'You explain license-check decisions to a publisher in plain, everyday language. The decision is final and already made; ' +
        'do not question or soften it. Use only the facts given. Don’t mention rule codes, IDs or legal jargon. ' +
        'Keep the explanation to two sentences and the fix to one.',
      prompt: `Verdict: BLOCK\nFailed rules:\n${failed.map((f) => `- ${f.ruleId}: ${f.message}`).join('\n')}`,
      schema: ExplanationSchema,
    });
    return { verdict: 'block', ...data, source: 'vertex' };
  } catch {
    return fallback;
  }
}
