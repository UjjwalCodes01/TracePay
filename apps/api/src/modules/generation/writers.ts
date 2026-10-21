import { z } from 'zod';
import type { BuildIntent } from '@tracepay/shared';
import { aiReady } from '../../config/env';
import { generateStructured } from '../../integrations/ai/vertex';
import type { CitationError, DraftSection } from './citations';
import type { RetrievedPassage } from './retrieval';

export interface WriterInput {
  intent: BuildIntent;
  passages: Array<RetrievedPassage & { sourceTitle: string }>;
  /** Citation errors from a previous attempt, fed back for one repair pass. */
  previousErrors?: CitationError[];
}

export interface WriterOutput {
  sections: DraftSection[];
  model: string;
  fromFixture: boolean;
}

export interface ReportWriter {
  readonly name: string;
  write(input: WriterInput): Promise<WriterOutput>;
}

// ---------------------------------------------------------------- Vertex AI writer

const ReportSchema = z.object({
  summary: z.string().min(20).max(1200),
  findings: z
    .array(z.object({ heading: z.string().min(3).max(120), body: z.string().min(20).max(1200) }))
    .min(3)
    .max(6),
  outlook: z.string().min(20).max(1200),
});

const SYSTEM = [
  'You write paid market-intelligence briefs for a research studio that licenses its sources.',
  'Rules you must follow:',
  '1. Use ONLY the numbered source excerpts provided. Do not use outside knowledge.',
  '2. Every factual claim or number must be followed by the marker of the excerpt it came from, e.g. [C3]. Cite only markers that appear in the list.',
  '3. Never invent numbers, sources, companies or quotes.',
  '4. Paraphrase and synthesise. Never copy more than a short phrase verbatim: redistributing raw source text is prohibited by the licenses.',
  '5. Each finding must cite at least one excerpt. The summary and outlook may synthesise findings without new claims.',
].join('\n');

export class VertexReportWriter implements ReportWriter {
  readonly name = 'vertex';

  async write(input: WriterInput): Promise<WriterOutput> {
    const excerpts = input.passages.map((p) => `[${p.handle}] (${p.sourceTitle}) ${p.text}`).join('\n');
    const repair = input.previousErrors?.length
      ? `\n\nYour previous draft was rejected by the citation validator:\n${input.previousErrors.map((e) => `- ${e.message}`).join('\n')}\nFix these problems.`
      : '';
    const prompt =
      `Report title: ${input.intent.title}\nBrief: ${input.intent.brief}\n\nSource excerpts:\n${excerpts}\n\n` +
      'Write a summary, 3 to 5 findings with short headings, and an outlook.' +
      repair;

    const { data, model } = await generateStructured({ system: SYSTEM, prompt, schema: ReportSchema, temperature: 0.3 });
    return {
      model,
      fromFixture: false,
      sections: [
        { key: 'summary', heading: 'Summary', body: data.summary, requiresCitation: false },
        ...data.findings.map((f, i) => ({ key: `finding_${i + 1}`, heading: f.heading, body: f.body, requiresCitation: true })),
        { key: 'outlook', heading: 'Outlook', body: data.outlook, requiresCitation: false },
      ],
    };
  }
}

// ---------------------------------------------------------------- Fixture writer

const firstSentence = (text: string) => (text.match(/^.*?[.!?](\s|$)/)?.[0] ?? text).trim();

/**
 * Deterministic extractive writer used when Vertex AI is not configured.
 * Output is always labeled `fromFixture: true` and must never be presented
 * as live model output.
 */
export class FixtureReportWriter implements ReportWriter {
  readonly name = 'fixture';

  async write(input: WriterInput): Promise<WriterOutput> {
    // Round-robin across sources so every approved source has a chance to be cited.
    const bySource = new Map<string, WriterInput['passages']>();
    for (const p of input.passages) bySource.set(p.assetVersionId, [...(bySource.get(p.assetVersionId) ?? []), p]);
    const ordered: WriterInput['passages'] = [];
    for (let round = 0; ordered.length < input.passages.length; round++) {
      for (const list of bySource.values()) if (list[round]) ordered.push(list[round]!);
    }
    const picks = ordered.slice(0, 5);

    return {
      model: 'fixture/extractive-v1',
      fromFixture: true,
      sections: [
        {
          key: 'summary',
          heading: 'Summary',
          body: `${input.intent.title}: ${picks.length} findings drawn from ${bySource.size} licensed sources. (Fixture output — Vertex AI not configured.)`,
          requiresCitation: false,
        },
        ...picks.map((p, i) => ({
          key: `finding_${i + 1}`,
          heading: `Finding ${i + 1} — ${p.sourceTitle}`,
          body: `${firstSentence(p.text)} [${p.handle}]`,
          requiresCitation: true,
        })),
        {
          key: 'outlook',
          heading: 'Outlook',
          body: 'The findings above are drawn verbatim-extractively from licensed sources; a live model run synthesises them into an outlook.',
          requiresCitation: false,
        },
      ],
    };
  }
}

export type GenerationMode = 'vertex' | 'fixture' | 'auto';

export function pickWriter(mode: GenerationMode = (process.env.GENERATION_MODE as GenerationMode) ?? 'auto'): ReportWriter {
  if (mode === 'fixture') return new FixtureReportWriter();
  if (mode === 'vertex') return new VertexReportWriter();
  return aiReady() ? new VertexReportWriter() : new FixtureReportWriter();
}
