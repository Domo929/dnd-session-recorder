import fs from 'fs';
import os from 'os';
import path from 'path';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import {
  generateText,
  experimental_transcribe as transcribe,
  type LanguageModel,
} from 'ai';

/**
 * Centralized, provider-agnostic access to the AI services
 * (audio transcription + narrative text generation).
 *
 * The active provider is selected at runtime via environment variables so the
 * same image can run against OpenAI, Google Gemini, or a local whisper.cpp
 * build without code changes:
 *
 *   AI_TRANSCRIPTION_PROVIDER = openai | google | whisper-local   (default: openai)
 *   AI_SUMMARY_PROVIDER       = openai | google                   (default: openai)
 *
 * Per-provider model overrides:
 *   OPENAI_TRANSCRIPTION_MODEL (default: whisper-1)
 *   OPENAI_SUMMARY_MODEL       (default: gpt-4o)
 *   GOOGLE_TRANSCRIPTION_MODEL (default: gemini-2.5-flash)
 *   GOOGLE_SUMMARY_MODEL       (default: gemini-2.5-flash)
 *   WHISPER_MODEL              (default: base.en)
 *   WHISPER_MODELS_DIR, WHISPER_USE_CUDA
 *
 * When `MOCK_AI_SERVICES=true` every call returns a deterministic fixture
 * instead of hitting a real provider. This lets PR-stage integration tests
 * exercise the full transcription -> summary pipeline without spending API
 * credits or needing real API keys.
 */
export function isAiMocked(): boolean {
  return process.env.MOCK_AI_SERVICES === 'true';
}

export type AiTextKind = 'summary' | 'dm-todo';

type TranscriptionProvider = 'openai' | 'google' | 'whisper-local';
type SummaryProvider = 'openai' | 'google';

function transcriptionProvider(): TranscriptionProvider {
  const value = (process.env.AI_TRANSCRIPTION_PROVIDER ?? '').toLowerCase().trim();
  if (value === 'google' || value === 'openai' || value === 'whisper-local') {
    return value;
  }
  return 'openai';
}

function summaryProvider(): SummaryProvider {
  const value = (process.env.AI_SUMMARY_PROVIDER ?? '').toLowerCase().trim();
  if (value === 'google' || value === 'openai') {
    return value;
  }
  return 'openai';
}

const MOCK_TRANSCRIPT =
  'The party entered the ruined keep at dusk. Thalia rolled a natural twenty on her ' +
  'perception check and spotted a hidden trapdoor beneath the rubble. After a short rest ' +
  'they descended into the crypt below, where Bren disarmed a glyph of warding and the ' +
  'group recovered the Sunstone Amulet.';

const MOCK_TEXT: Record<AiTextKind, string> = {
  summary:
    '# Session Summary\n\n' +
    'The party explored the ruined keep and uncovered a hidden crypt. ' +
    'Thalia led the way after spotting a concealed trapdoor, and Bren safely ' +
    'disarmed a magical glyph. The session ended with the recovery of the ' +
    'Sunstone Amulet.\n\n' +
    '## Key Events\n- Discovery of the hidden crypt\n- Recovery of the Sunstone Amulet',
  'dm-todo':
    '# DM TODO List\n\n' +
    '## Top Priorities\n' +
    '- [ ] Decide what the Sunstone Amulet does mechanically\n' +
    '- [ ] Prepare the crypt guardian for next session\n' +
    "- [ ] Follow up on the glyph of warding's origin",
};

/**
 * Maximum per-chunk size (MB) the active transcription provider can accept in
 * a single request. The caller splits audio to this size before transcribing.
 *
 * - openai/whisper-local: 18 MB (under Whisper's 25 MB upload limit).
 * - google: 14 MB raw — Gemini inline audio is capped at ~20 MB per request and
 *   base64 encoding inflates payloads ~33%, so 14 MB keeps us safely under it.
 */
export function maxTranscriptionChunkSizeMB(): number {
  return transcriptionProvider() === 'google' ? 14 : 18;
}

/**
 * Transcribe a single audio chunk. Returns the transcript text.
 *
 * `audio` is the raw bytes of one chunk; the caller is responsible for
 * splitting large files (see `maxTranscriptionChunkSizeMB`).
 */
export async function transcribeAudio(audio: Buffer): Promise<{ text: string }> {
  if (isAiMocked()) {
    return { text: MOCK_TRANSCRIPT };
  }

  const provider = transcriptionProvider();
  switch (provider) {
    case 'google':
      return transcribeWithGoogle(audio);
    case 'whisper-local':
      return transcribeWithWhisperLocal(audio);
    case 'openai':
    default:
      return transcribeWithOpenAI(audio);
  }
}

async function transcribeWithOpenAI(audio: Buffer): Promise<{ text: string }> {
  const modelId = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
  const result = await transcribe({
    model: openai.transcription(modelId),
    audio,
  });
  return { text: result.text };
}

const GEMINI_TRANSCRIPTION_PROMPT =
  'Transcribe the following audio verbatim. Preserve sentence boundaries and natural ' +
  'punctuation. When multiple distinct voices are present, prefix each speaker turn with ' +
  'a label like "Speaker 1:", "Speaker 2:", etc. — use consistent labels for the same ' +
  'speaker across the chunk. If you cannot reliably distinguish speakers, omit labels ' +
  'rather than guess. Output only the transcript text with no commentary and no timestamps.';

/**
 * Gemini has no dedicated transcription endpoint, so we send the audio as an
 * inline file part to a multimodal `generateText` call. The media type is
 * sniffed from the buffer's magic bytes (the caller no longer carries the
 * original file extension).
 */
async function transcribeWithGoogle(audio: Buffer): Promise<{ text: string }> {
  const modelId = process.env.GOOGLE_TRANSCRIPTION_MODEL || 'gemini-2.5-flash';
  const { text } = await generateText({
    model: google(modelId),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: GEMINI_TRANSCRIPTION_PROMPT },
          { type: 'file', data: audio, mediaType: sniffAudioMime(audio) },
        ],
      },
    ],
  });
  return { text };
}

/**
 * Local whisper.cpp transcription via the optional `nodejs-whisper` package.
 *
 * nodejs-whisper operates on files, so the in-memory chunk is written to a
 * temp file (with an extension inferred from its magic bytes) for the duration
 * of the call. The package is imported lazily so the rest of the app doesn't
 * fail at import time when this optional dependency isn't installed/built.
 */
async function transcribeWithWhisperLocal(audio: Buffer): Promise<{ text: string }> {
  const modelName = process.env.WHISPER_MODEL || 'base.en';
  const modelRootPath = process.env.WHISPER_MODELS_DIR
    ? path.resolve(process.env.WHISPER_MODELS_DIR)
    : undefined;
  const withCuda = (process.env.WHISPER_USE_CUDA ?? '').toLowerCase() === 'true';

  if (modelRootPath && !fs.existsSync(modelRootPath)) {
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const audioPath = path.join(tmpDir, `chunk${extForMime(sniffAudioMime(audio))}`);
  fs.writeFileSync(audioPath, audio);

  try {
    const result = await nodewhisper(audioPath, {
      modelName,
      autoDownloadModelName: modelName,
      ...(modelRootPath ? { modelRootPath } : {}),
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

    // Belt-and-suspenders: nodewhisper may return '' but write a .txt sidecar.
    if (!transcript) {
      const candidates = [
        `${audioPath}.txt`,
        `${audioPath}.wav.txt`,
        path.join(tmpDir, `${path.basename(audioPath, path.extname(audioPath))}.txt`),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          transcript = fs.readFileSync(candidate, 'utf8').trim();
          break;
        }
      }
    }

    if (!transcript) {
      throw new Error('Local whisper produced an empty transcript');
    }
    return { text: transcript };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Generate narrative text (session summary or DM TODO list).
 * `kind` only affects the deterministic output returned in mock mode.
 */
export async function generateAiText(prompt: string, kind: AiTextKind): Promise<{ text: string }> {
  if (isAiMocked()) {
    return { text: MOCK_TEXT[kind] };
  }

  const result = await generateText({
    model: summaryModel(),
    prompt,
  });
  return { text: result.text };
}

function summaryModel(): LanguageModel {
  switch (summaryProvider()) {
    case 'google':
      return google(process.env.GOOGLE_SUMMARY_MODEL || 'gemini-2.5-flash');
    case 'openai':
    default:
      return openai(process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o');
  }
}

/**
 * Infer an audio MIME type from a buffer's magic bytes. Used to label inline
 * audio for Gemini and to pick a temp-file extension for whisper.cpp.
 */
function sniffAudioMime(buf: Buffer): string {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') {
    return 'audio/flac';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') {
    return 'audio/ogg';
  }
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') {
    return 'audio/mpeg';
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return 'audio/mp4';
  }
  return 'audio/mpeg';
}

function extForMime(mime: string): string {
  switch (mime) {
    case 'audio/wav':
      return '.wav';
    case 'audio/flac':
      return '.flac';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/mp4':
      return '.m4a';
    case 'audio/mpeg':
    default:
      return '.mp3';
  }
}
