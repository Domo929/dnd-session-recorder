import { describe, it, expect } from 'vitest';
import {
  metrics,
  estimateTokenCostUsd,
  estimateTokensFromChars,
  recordAiCall,
  recordVoiceMatch,
} from '@/lib/metrics';

async function scrape(): Promise<string> {
  return metrics.registry.metrics();
}

describe('estimateTokensFromChars', () => {
  it('uses the ~4 chars/token heuristic and floors at zero', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-50)).toBe(0);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(10)).toBe(3); // ceil(10/4)
  });
});

describe('estimateTokenCostUsd', () => {
  it('prices a known provider:model from token usage', () => {
    // gpt-4o: $2.5/1M in, $10/1M out
    const cost = estimateTokenCostUsd('openai', 'gpt-4o', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.5, 6);
  });

  it('returns 0 for unknown models', () => {
    expect(estimateTokenCostUsd('openai', 'whisper-1', 1000, 0)).toBe(0);
    expect(estimateTokenCostUsd('acme', 'mystery', 9, 9)).toBe(0);
  });
});

describe('recordAiCall', () => {
  it('increments request, token and cost series for a priced model', async () => {
    recordAiCall({
      provider: 'openai',
      model: 'gpt-4o',
      kind: 'summary',
      status: 'success',
      durationSeconds: 1.5,
      inputTokens: 1000,
      outputTokens: 500,
    });
    const out = await scrape();
    expect(out).toContain('dndrec_ai_requests_total');
    expect(out).toContain('kind="summary"');
    expect(out).toContain('dndrec_ai_tokens_total');
    expect(out).toContain('dndrec_ai_cost_usd_total');
    expect(out).toContain('dndrec_ai_request_duration_seconds');
  });

  it('records errors without tokens/cost', async () => {
    recordAiCall({
      provider: 'openai',
      model: 'whisper-1',
      kind: 'transcription',
      status: 'error',
      durationSeconds: 0.2,
    });
    const out = await scrape();
    expect(out).toContain('status="error"');
    expect(out).toContain('kind="transcription"');
  });
});

describe('recordVoiceMatch', () => {
  it('counts by confidence and observes finite scores only', async () => {
    recordVoiceMatch('high', 0.91);
    recordVoiceMatch('none', null);
    const out = await scrape();
    expect(out).toContain('dndrec_voice_matches_total');
    expect(out).toContain('confidence="high"');
    expect(out).toContain('confidence="none"');
    expect(out).toContain('dndrec_voice_match_score');
  });
});

describe('registry', () => {
  it('exposes Node default process metrics', async () => {
    const out = await scrape();
    expect(out).toContain('dndrec_process_cpu_user_seconds_total');
    expect(out).toMatch(/dndrec_nodejs_/);
  });
});
