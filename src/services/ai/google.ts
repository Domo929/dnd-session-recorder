import fs from 'fs';
import { google } from '@ai-sdk/google';
import { generateText, type LanguageModel } from 'ai';
import type { SummaryService, TranscriptionService } from './types';
import {
  INLINE_AUDIO_CHUNK_MB,
  audioMimeFor,
  cleanupChunks,
  splitAudioBySize,
} from './audioChunker';

const DEFAULT_SUMMARY_MODEL = 'gemini-2.5-flash';
const DEFAULT_TRANSCRIPTION_MODEL = 'gemini-2.5-flash';

export class GoogleTranscriptionService implements TranscriptionService {
  readonly name = 'google' as const;

  async transcribe(audioPath: string): Promise<string> {
    const modelId = process.env.GOOGLE_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL;
    console.log(`[AI] Using Google transcription model: ${modelId}`);

    // Gemini inline audio is capped at ~20MB per request. We reuse the same
    // ffmpeg-based chunker the OpenAI path uses to stay under that limit.
    // For larger files the Google Files API would be needed; that's a follow-up.
    const chunkPaths = await splitAudioBySize(audioPath, INLINE_AUDIO_CHUNK_MB);
    console.log(`[Transcription] Audio split into ${chunkPaths.length} chunk(s)`);

    try {
      const texts: string[] = [];
      for (let i = 0; i < chunkPaths.length; i++) {
        const chunkPath = chunkPaths[i];
        console.log(
          `[Transcription] Transcribing chunk ${i + 1}/${chunkPaths.length} with Gemini: ${chunkPath}`,
        );
        const audio = fs.readFileSync(chunkPath);
        const { text } = await generateText({
          model: google(modelId),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    'Transcribe the following audio verbatim. Preserve sentence boundaries and natural punctuation. ' +
                    'When multiple distinct voices are present, prefix each speaker turn with a label like ' +
                    '"Speaker 1:", "Speaker 2:", etc. — use consistent labels for the same speaker across the chunk. ' +
                    'If you cannot reliably distinguish speakers, omit labels rather than guess. ' +
                    'Output only the transcript text with no commentary and no timestamps.',
                },
                {
                  type: 'file',
                  data: audio,
                  mediaType: audioMimeFor(chunkPath),
                },
              ],
            },
          ],
        });
        if (!text) {
          throw new Error(`Gemini returned no transcription text for chunk ${i + 1}`);
        }
        texts.push(text);
        console.log(`[Transcription] Chunk ${i + 1} transcribed.`);
      }
      return texts.join(' ');
    } finally {
      cleanupChunks(chunkPaths, audioPath);
    }
  }
}

export class GoogleSummaryService implements SummaryService {
  readonly name = 'google' as const;

  getModel(): LanguageModel {
    const modelId = process.env.GOOGLE_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL;
    console.log(`[AI] Using Google summary model: ${modelId}`);
    return google(modelId);
  }
}
