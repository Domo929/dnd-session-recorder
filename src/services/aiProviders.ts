import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import {
  experimental_transcribe as transcribe,
  generateText,
  type LanguageModel,
} from 'ai';

export type SummaryProvider = 'openai' | 'google';
export type TranscriptionProvider = 'openai' | 'google' | 'whisper-local';

const DEFAULT_SUMMARY_PROVIDER: SummaryProvider = 'openai';
const DEFAULT_TRANSCRIPTION_PROVIDER: TranscriptionProvider = 'openai';

const DEFAULT_OPENAI_SUMMARY_MODEL = 'gpt-4o';
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';
const DEFAULT_GOOGLE_SUMMARY_MODEL = 'gemini-2.5-flash';
const DEFAULT_GOOGLE_TRANSCRIPTION_MODEL = 'gemini-2.5-flash';
const DEFAULT_WHISPER_MODEL = 'base.en';
const DEFAULT_WHISPER_MODELS_DIR = './whisper-models';

// Inline audio payloads must stay below the Gemini ~20MB request cap.
// Use the same headroom (18MB) the OpenAI path already uses for Whisper.
const INLINE_AUDIO_CHUNK_MB = 18;

function getSummaryProvider(): SummaryProvider {
  const value = (process.env.AI_SUMMARY_PROVIDER ?? '').toLowerCase().trim();
  if (value === 'google' || value === 'openai') return value;
  return DEFAULT_SUMMARY_PROVIDER;
}

function getTranscriptionProvider(): TranscriptionProvider {
  const value = (process.env.AI_TRANSCRIPTION_PROVIDER ?? '').toLowerCase().trim();
  if (value === 'google' || value === 'openai' || value === 'whisper-local') return value;
  return DEFAULT_TRANSCRIPTION_PROVIDER;
}

export function getSummaryModel(): LanguageModel {
  const provider = getSummaryProvider();
  if (provider === 'google') {
    const modelId = process.env.GOOGLE_SUMMARY_MODEL || DEFAULT_GOOGLE_SUMMARY_MODEL;
    console.log(`[AI] Using Google summary model: ${modelId}`);
    return google(modelId);
  }

  const modelId = process.env.OPENAI_SUMMARY_MODEL || DEFAULT_OPENAI_SUMMARY_MODEL;
  console.log(`[AI] Using OpenAI summary model: ${modelId}`);
  return openai(modelId);
}

// Splits an audio file into ~chunkSizeMB pieces using ffmpeg.
// Returns the original path in a single-element array when no split is needed.
async function splitAudioBySize(inputPath: string, chunkSizeMB: number): Promise<string[]> {
  const stats = fs.statSync(inputPath);
  const totalSize = stats.size;
  const chunkSize = chunkSizeMB * 1024 * 1024;
  const numChunks = Math.ceil(totalSize / chunkSize);

  if (numChunks <= 1) {
    console.log(`[Audio Split] File is under ${chunkSizeMB}MB, no split needed.`);
    return [inputPath];
  }

  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  const dir = path.dirname(inputPath);
  const chunkPaths: string[] = [];

  const duration = await new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
  const chunkDuration = duration / numChunks;

  console.log(
    `[Audio Split] Splitting ${inputPath} into ${numChunks} chunks of ~${chunkSizeMB}MB each (~${chunkDuration.toFixed(2)}s per chunk)`,
  );

  await Promise.all(
    Array.from({ length: numChunks }, (_, i) => {
      const output = path.join(dir, `${base}_chunk${i}${ext}`);
      chunkPaths.push(output);
      return new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(i * chunkDuration)
          .setDuration(chunkDuration)
          .output(output)
          .on('end', () => {
            console.log(`[Audio Split] Created chunk: ${output}`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`[Audio Split] Error creating chunk ${output}:`, err);
            reject(err);
          })
          .run();
      });
    }),
  );

  return chunkPaths;
}

function cleanupChunks(chunkPaths: string[], originalPath: string): void {
  for (const p of chunkPaths) {
    if (p === originalPath) continue;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        console.warn(`[Audio Split] Failed to remove chunk ${p}:`, err);
      }
    }
  }
}

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
};

function audioMimeFor(filePath: string): string {
  return AUDIO_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'audio/mpeg';
}

async function transcribeWithOpenAI(audioPath: string): Promise<string> {
  const modelId = process.env.OPENAI_TRANSCRIPTION_MODEL || DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
  console.log(`[AI] Using OpenAI transcription model: ${modelId}`);

  const chunkPaths = await splitAudioBySize(audioPath, INLINE_AUDIO_CHUNK_MB);
  console.log(`[Transcription] Audio split into ${chunkPaths.length} chunk(s)`);

  try {
    const texts: string[] = [];
    for (let i = 0; i < chunkPaths.length; i++) {
      const chunkPath = chunkPaths[i];
      console.log(`[Transcription] Transcribing chunk ${i + 1}/${chunkPaths.length}: ${chunkPath}`);
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

async function transcribeWithGoogle(audioPath: string): Promise<string> {
  const modelId = process.env.GOOGLE_TRANSCRIPTION_MODEL || DEFAULT_GOOGLE_TRANSCRIPTION_MODEL;
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
                  'Output only the transcript text with no commentary, no timestamps, and no speaker labels.',
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

async function transcribeWithLocalWhisper(audioPath: string): Promise<string> {
  const modelName = process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL;
  const modelRootPath = path.resolve(process.env.WHISPER_MODELS_DIR || DEFAULT_WHISPER_MODELS_DIR);
  const withCuda = (process.env.WHISPER_USE_CUDA ?? '').toLowerCase() === 'true';

  console.log(
    `[AI] Using local whisper.cpp model: ${modelName} (modelsDir=${modelRootPath}, cuda=${withCuda})`,
  );

  if (!fs.existsSync(modelRootPath)) {
    fs.mkdirSync(modelRootPath, { recursive: true });
  }

  let nodewhisper: typeof import('nodejs-whisper').nodewhisper;
  try {
    ({ nodewhisper } = await import('nodejs-whisper'));
  } catch (err) {
    throw new Error(
      'AI_TRANSCRIPTION_PROVIDER=whisper-local requires the optional "nodejs-whisper" package ' +
        'to be installed and successfully built (needs make/cmake/g++/python3 + ffmpeg on the host). ' +
        'Run `npm install` after installing the build prerequisites. ' +
        `Original import error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // nodewhisper resolves to the transcript content for the configured output.
  // It also writes a sibling `<audio>.wav.txt` next to the input.
  const result = await nodewhisper(audioPath, {
    modelName,
    autoDownloadModelName: modelName,
    modelRootPath,
    withCuda,
    removeWavFileAfterTranscription: true,
    whisperOptions: {
      outputInText: true,
      outputInSrt: false,
      outputInVtt: false,
      outputInCsv: false,
      outputInJson: false,
      outputInJsonFull: false,
      outputInLrc: false,
      outputInWords: false,
      translateToEnglish: false,
      wordTimestamps: false,
      splitOnWord: true,
      timestamps_length: 20,
    },
  });

  let transcript = typeof result === 'string' ? result.trim() : '';

  // Belt-and-suspenders: if nodewhisper returned an empty string but wrote
  // a .txt sidecar, read it from disk.
  if (!transcript) {
    const candidates = [
      `${audioPath}.txt`,
      `${audioPath}.wav.txt`,
      path.join(
        path.dirname(audioPath),
        `${path.basename(audioPath, path.extname(audioPath))}.txt`,
      ),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        transcript = fs.readFileSync(candidate, 'utf8').trim();
        try {
          fs.unlinkSync(candidate);
        } catch {
          /* best-effort cleanup */
        }
        break;
      }
    }
  }

  if (!transcript) {
    throw new Error('Local whisper produced an empty transcript');
  }
  return transcript;
}

export async function transcribeAudio(audioPath: string): Promise<string> {
  const provider = getTranscriptionProvider();
  console.log(`[AI] Transcription provider: ${provider}`);

  switch (provider) {
    case 'google':
      return transcribeWithGoogle(audioPath);
    case 'whisper-local':
      return transcribeWithLocalWhisper(audioPath);
    case 'openai':
    default:
      return transcribeWithOpenAI(audioPath);
  }
}
