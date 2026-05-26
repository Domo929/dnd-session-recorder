import type { LanguageModel } from 'ai';
import {
  DEFAULT_SUMMARY_PROVIDER,
  DEFAULT_TRANSCRIPTION_PROVIDER,
  type SummaryProvider,
  type SummaryService,
  type TranscriptionProvider,
  type TranscriptionService,
} from './types';
import { OpenAISummaryService, OpenAITranscriptionService } from './openai';
import { GoogleSummaryService, GoogleTranscriptionService } from './google';
import { LocalWhisperTranscriptionService } from './whisperLocal';
import { MockSummaryService, MockTranscriptionService } from './mock';

export type {
  SummaryProvider,
  SummaryService,
  TranscriptionProvider,
  TranscriptionService,
} from './types';
export { OpenAISummaryService, OpenAITranscriptionService } from './openai';
export { GoogleSummaryService, GoogleTranscriptionService } from './google';
export { LocalWhisperTranscriptionService } from './whisperLocal';

function readTranscriptionProvider(): TranscriptionProvider {
  const value = (process.env.AI_TRANSCRIPTION_PROVIDER ?? '').toLowerCase().trim();
  if (
    value === 'google' ||
    value === 'openai' ||
    value === 'whisper-local' ||
    value === 'mock'
  )
    return value;
  return DEFAULT_TRANSCRIPTION_PROVIDER;
}

function readSummaryProvider(): SummaryProvider {
  const value = (process.env.AI_SUMMARY_PROVIDER ?? '').toLowerCase().trim();
  if (value === 'google' || value === 'openai' || value === 'mock') return value;
  return DEFAULT_SUMMARY_PROVIDER;
}

/**
 * Constructs the transcription service for the configured provider.
 * Services are stateless and cheap to instantiate; no need to cache.
 */
export function getTranscriptionService(): TranscriptionService {
  const provider = readTranscriptionProvider();
  console.log(`[AI] Transcription provider: ${provider}`);
  switch (provider) {
    case 'google':
      return new GoogleTranscriptionService();
    case 'whisper-local':
      return new LocalWhisperTranscriptionService();
    case 'mock':
      return new MockTranscriptionService();
    case 'openai':
    default:
      return new OpenAITranscriptionService();
  }
}

/**
 * Constructs the summary service for the configured provider.
 */
export function getSummaryService(): SummaryService {
  const provider = readSummaryProvider();
  switch (provider) {
    case 'google':
      return new GoogleSummaryService();
    case 'mock':
      return new MockSummaryService();
    case 'openai':
    default:
      return new OpenAISummaryService();
  }
}

/**
 * Convenience: transcribe via the configured service. Equivalent to
 * `getTranscriptionService().transcribe(audioPath)`.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  return getTranscriptionService().transcribe(audioPath);
}

/**
 * Convenience: get the LanguageModel for the configured summary service.
 * Equivalent to `getSummaryService().getModel()`.
 */
export function getSummaryModel(): LanguageModel {
  return getSummaryService().getModel();
}
