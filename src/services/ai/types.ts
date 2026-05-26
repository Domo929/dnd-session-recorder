import type { LanguageModel } from 'ai';

export type SummaryProvider = 'openai' | 'google' | 'mock';
export type TranscriptionProvider = 'openai' | 'google' | 'whisper-local' | 'mock';

export const DEFAULT_SUMMARY_PROVIDER: SummaryProvider = 'openai';
export const DEFAULT_TRANSCRIPTION_PROVIDER: TranscriptionProvider = 'openai';

/**
 * Per-call transcription. Stateless; safe to construct fresh per request.
 */
export interface TranscriptionService {
  readonly name: TranscriptionProvider;
  transcribe(audioPath: string): Promise<string>;
}

/**
 * Returns a Vercel AI SDK LanguageModel for summary generation.
 * The caller (e.g. the summary route) wraps this with prompts and `generateText`.
 */
export interface SummaryService {
  readonly name: SummaryProvider;
  getModel(): LanguageModel;
}
