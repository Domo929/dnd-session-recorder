import fs from 'fs';
import { openai } from '@ai-sdk/openai';
import { experimental_transcribe as transcribe, type LanguageModel } from 'ai';
import type { SummaryService, TranscriptionService } from './types';
import { INLINE_AUDIO_CHUNK_MB, cleanupChunks, splitAudioBySize } from './audioChunker';

const DEFAULT_SUMMARY_MODEL = 'gpt-4o';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';

export class OpenAITranscriptionService implements TranscriptionService {
  readonly name = 'openai' as const;

  async transcribe(audioPath: string): Promise<string> {
    const modelId = process.env.OPENAI_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL;
    console.log(`[AI] Using OpenAI transcription model: ${modelId}`);

    const chunkPaths = await splitAudioBySize(audioPath, INLINE_AUDIO_CHUNK_MB);
    console.log(`[Transcription] Audio split into ${chunkPaths.length} chunk(s)`);

    try {
      const texts: string[] = [];
      for (let i = 0; i < chunkPaths.length; i++) {
        const chunkPath = chunkPaths[i];
        console.log(
          `[Transcription] Transcribing chunk ${i + 1}/${chunkPaths.length}: ${chunkPath}`,
        );
        const audio = fs.readFileSync(chunkPath);
        const result = await transcribe({
          model: openai.transcription(modelId),
          audio,
        });
        if (!result.text) {
          throw new Error(`No transcription text received for chunk ${i + 1}`);
        }
        texts.push(result.text);
        console.log(`[Transcription] Chunk ${i + 1} transcribed.`);
      }
      return texts.join(' ');
    } finally {
      cleanupChunks(chunkPaths, audioPath);
    }
  }
}

export class OpenAISummaryService implements SummaryService {
  readonly name = 'openai' as const;

  getModel(): LanguageModel {
    const modelId = process.env.OPENAI_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL;
    console.log(`[AI] Using OpenAI summary model: ${modelId}`);
    return openai(modelId);
  }
}
