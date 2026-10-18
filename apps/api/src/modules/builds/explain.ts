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
      headline: 'Every selected source is licensed for this deliverable.',
      explanation: report.obligations.length ? `Attribution required: ${report.obligations.map((o) => `"${o.text}"`).join('; ')}.` : 'No attribution obligations.',
      suggestedFix: null,
      source: 'rules',
    };
  }

  const fallback: Explanation = {
    verdict: 'block',
    headline: `Blocked by ${failed.length} license rule${failed.length === 1 ? '' : 's'}.`,
    explanation: failed.map((f) => f.message).join(' '),
    suggestedFix: 'Replace the blocked source with one whose license permits this use, or change the intended use.',
    source: 'rules',
  };
  if (!useModel) return fallback;

  try {
    const { data } = await generateStructured({
      system:
        'You explain license-compiler decisions to a publisher in plain language. The decision is final and already made; ' +
        'do not question or soften it. Use only the facts given. Keep the explanation to two sentences and the fix to one.',
      prompt: `Verdict: BLOCK\nFailed rules:\n${failed.map((f) => `- ${f.ruleId}: ${f.message}`).join('\n')}`,
      schema: ExplanationSchema,
    });
    return { verdict: 'block', ...data, source: 'vertex' };
  } catch {
    return fallback;
  }
}
