/**
 * Cost estimation for (re-)summarization, so the UI can show the DM what a
 * re-summarize will cost before they trigger it (design Section 6).
 *
 * Pricing is USD per 1M tokens, keyed by `provider:model` matching the naming
 * in `src/lib/ai.ts`. Unknown models return null ("cost unavailable").
 */

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  'openai:gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'openai:gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'google:gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'google:gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },
};

/** Rough token heuristic: ~4 characters per token. */
export const CHARS_PER_TOKEN = 4;
/** Flat output-token allowance for a summary. */
export const SUMMARY_OUTPUT_TOKENS = 1000;

export interface SummaryCostEstimate {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Estimate the USD cost of summarizing `transcriptChars` characters of
 * transcript with the given provider/model. Returns null when the model has no
 * known pricing.
 */
export function estimateSummaryCost(
  provider: string,
  modelId: string,
  transcriptChars: number,
): SummaryCostEstimate | null {
  const price = MODEL_PRICING[`${provider}:${modelId}`];
  if (!price) return null;

  const inputTokens = Math.ceil(Math.max(0, transcriptChars) / CHARS_PER_TOKEN);
  const outputTokens = SUMMARY_OUTPUT_TOKENS;
  const costUsd =
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M;

  return { provider, modelId, inputTokens, outputTokens, costUsd };
}

/**
 * Resolve the configured summary provider + model from env, mirroring the
 * selection logic in `src/lib/ai.ts` (`summaryProvider`/`summaryModel`).
 */
export function getConfiguredSummaryModel(
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; modelId: string } {
  const raw = (env.AI_SUMMARY_PROVIDER ?? '').toLowerCase().trim();
  const provider = raw === 'google' ? 'google' : 'openai';
  const modelId =
    provider === 'google'
      ? env.GOOGLE_SUMMARY_MODEL || 'gemini-2.5-flash'
      : env.OPENAI_SUMMARY_MODEL || 'gpt-4o';
  return { provider, modelId };
}
