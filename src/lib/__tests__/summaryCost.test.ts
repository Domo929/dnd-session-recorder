import { describe, it, expect } from 'vitest';
import {
  estimateSummaryCost,
  getConfiguredSummaryModel,
  MODEL_PRICING,
} from '../summaryCost';

describe('estimateSummaryCost', () => {
  it('computes cost from known pricing', () => {
    // 40k chars -> 10k input tokens; gpt-4o = $2.50/1M in, $10/1M out, +1k out tokens.
    const est = estimateSummaryCost('openai', 'gpt-4o', 40000);
    expect(est).not.toBeNull();
    expect(est!.inputTokens).toBe(10000);
    expect(est!.outputTokens).toBe(1000);
    // 10000/1e6*2.5 + 1000/1e6*10 = 0.025 + 0.01 = 0.035
    expect(est!.costUsd).toBeCloseTo(0.035, 6);
  });

  it('returns null for an unknown model', () => {
    expect(estimateSummaryCost('openai', 'o1-mystery', 1000)).toBeNull();
  });

  it('treats negative chars as zero', () => {
    const est = estimateSummaryCost('google', 'gemini-2.5-flash', -50);
    expect(est!.inputTokens).toBe(0);
  });

  it('has pricing for the Phase B defaults', () => {
    expect(MODEL_PRICING['openai:gpt-4o']).toBeDefined();
    expect(MODEL_PRICING['google:gemini-2.5-flash']).toBeDefined();
  });
});

describe('getConfiguredSummaryModel', () => {
  it('defaults to openai gpt-4o', () => {
    expect(getConfiguredSummaryModel({} as NodeJS.ProcessEnv)).toEqual({
      provider: 'openai',
      modelId: 'gpt-4o',
    });
  });

  it('honors google provider + override', () => {
    expect(
      getConfiguredSummaryModel({
        AI_SUMMARY_PROVIDER: 'google',
        GOOGLE_SUMMARY_MODEL: 'gemini-1.5-pro',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ provider: 'google', modelId: 'gemini-1.5-pro' });
  });
});
