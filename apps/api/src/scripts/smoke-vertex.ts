/**
 * Day-1 Vertex AI proof: one structured-output call.
 *   npm run smoke:vertex -w @tracepay/api
 */
import { z } from 'zod';
import { generateStructured } from '../integrations/ai/vertex';

const Schema = z.object({
  summary: z.string(),
  ruleExplained: z.string(),
});

async function main() {
  const started = Date.now();
  const { data, model, usage } = await generateStructured({
    system: 'You explain license-check failures to publishers in one or two plain sentences. Never change the decision.',
    prompt:
      'Rule COMMERCIAL_USE failed for source "Dataset C": its approved license permits internal research only, ' +
      'but the build is a report for sale. Summarise the build status and explain the failed rule.',
    schema: Schema,
  });
  console.log(`✓ Vertex AI responded (${model}, ${Date.now() - started} ms, ${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out tokens)`);
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
