import { MockLanguageModelV2 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { SummaryService, TranscriptionService } from './types';

const MOCK_TRANSCRIPTION_TEXT =
  '[mock transcription] this is fake transcription output for local smoke tests.';
const MOCK_SUMMARY_TEXT =
  '[mock summary] this is a fake summary used by local smoke tests so we do not hit any real AI providers.';

export class MockTranscriptionService implements TranscriptionService {
  readonly name = 'mock' as const;

  async transcribe(): Promise<string> {
    console.log('[AI] Using MOCK transcription provider — returning fixed text.');
    return MOCK_TRANSCRIPTION_TEXT;
  }
}

export class MockSummaryService implements SummaryService {
  readonly name = 'mock' as const;

  getModel(): LanguageModel {
    console.log('[AI] Using MOCK summary provider — returning fixed text.');
    return new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'mock-summary',
      doGenerate: async () => ({
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: 'text', text: MOCK_SUMMARY_TEXT }],
        warnings: [],
      }),
    });
  }
}
