import fs from 'fs';
import os from 'os';
import path from 'path';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import {
  embedMany,
  generateText,
  streamText,
  experimental_transcribe as transcribe,
  type CoreMessage,
  type LanguageModel,
} from 'ai';
import {
  buildVocabularyPromptSection,
  buildVocabularyPhraseHint,
} from '@/lib/transcriptionVocabulary';

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

export type AiTextKind = 'summary' | 'dm-todo' | 'npc-inference';

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
  // Mock returns an empty suggestion array so mocked/test runs make no claims.
  'npc-inference': '[]',
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
export interface TranscriptionContext {
  /** Campaign vocabulary ("NPC / term dictionary") raw text, used to bias spelling. */
  vocabulary?: string | null;
}

export async function transcribeAudio(
  audio: Buffer,
  context?: TranscriptionContext,
): Promise<{ text: string }> {
  if (isAiMocked()) {
    return { text: MOCK_TRANSCRIPT };
  }

  const provider = transcriptionProvider();
  switch (provider) {
    case 'google':
      return transcribeWithGoogle(audio, context);
    case 'whisper-local':
      return transcribeWithWhisperLocal(audio, context);
    case 'openai':
    default:
      return transcribeWithOpenAI(audio, context);
  }
}

async function transcribeWithOpenAI(
  audio: Buffer,
  context?: TranscriptionContext,
): Promise<{ text: string }> {
  const modelId = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
  // Whisper accepts a free-text `prompt` that biases spelling of unusual words.
  const phraseHint = buildVocabularyPhraseHint(context?.vocabulary);
  const result = await transcribe({
    model: openai.transcription(modelId),
    audio,
    maxRetries: 0,
    ...(phraseHint
      ? { providerOptions: { openai: { prompt: phraseHint } } }
      : {}),
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
async function transcribeWithGoogle(
  audio: Buffer,
  context?: TranscriptionContext,
): Promise<{ text: string }> {
  const modelId = process.env.GOOGLE_TRANSCRIPTION_MODEL || 'gemini-2.5-flash';
  const prompt =
    GEMINI_TRANSCRIPTION_PROMPT + buildVocabularyPromptSection(context?.vocabulary);
  const { text } = await generateText({
    model: google(modelId),
    maxRetries: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
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
async function transcribeWithWhisperLocal(
  audio: Buffer,
  // Vocabulary biasing is not wired for whisper-local: nodejs-whisper does not
  // expose an initial-prompt option. The param exists for a uniform signature.
  _context?: TranscriptionContext,
): Promise<{ text: string }> {
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

const EMBEDDING_DIM = 768;

function mockEmbedding(text: string): number[] {
  // Deterministic pseudo-vector from a simple rolling hash. Mock-only.
  const v = new Array<number>(EMBEDDING_DIM);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) * 16777619;
  }
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    h = (h * 48271) % 2147483647;
    v[i] = (h % 1000) / 1000;
  }
  return v;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (isAiMocked()) return texts.map(mockEmbedding);
  const modelId = process.env.GOOGLE_EMBEDDING_MODEL || 'text-embedding-004';
  const { embeddings } = await embedMany({
    model: google.textEmbeddingModel(modelId),
    values: texts,
  });
  return embeddings;
}

const CHAT_SYSTEM_PROMPT =
  'You are a helpful assistant answering questions about a Dungeons & Dragons campaign. ' +
  'Answer ONLY using the provided context excerpts. If the context does not contain the ' +
  'answer, say you could not find it in the campaign records. When you use an excerpt, cite ' +
  'it inline using its bracketed citation tag exactly as given.';

export function buildChatMessages(
  context: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): CoreMessage[] {
  return [
    { role: 'system', content: `${CHAT_SYSTEM_PROMPT}\n\nContext:\n${context}` },
    ...history,
  ];
}

export function streamCampaignChat(messages: CoreMessage[]) {
  const modelId = process.env.GOOGLE_SUMMARY_MODEL || 'gemini-2.5-flash';
  return streamText({ model: google(modelId), messages });
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

/* ------------------------------------------------------------------ *
 * Pacing + adaptive backoff for rate-limited transcription providers.
 *
 * Sequential chunk transcription against Gemini (or any provider) is
 * paced to stay under the per-minute request quota, and individual
 * rate-limit / overload failures are retried with the server's suggested
 * delay (falling back to exponential backoff) before giving up. These
 * helpers are pure / dependency-injectable so they unit-test without
 * real timers or network. See
 * docs/plans/2026-05-29-resumable-transcription-design.md.
 * ------------------------------------------------------------------ */

export interface BackoffConfig {
  /** Max retry attempts after the first try before giving up. */
  maxRetries: number;
  /** First fallback backoff (ms) when the server gives no hint. */
  baseMs: number;
  /** Upper bound (ms) on any single backoff wait. */
  maxMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Backoff configuration from env with safe defaults. */
export function getBackoffConfig(): BackoffConfig {
  const baseMs = parsePositiveInt(process.env.TRANSCRIPTION_BACKOFF_BASE_MS, 5000);
  const maxMs = parsePositiveInt(process.env.TRANSCRIPTION_BACKOFF_MAX_MS, 60000);
  return {
    maxRetries: parsePositiveInt(process.env.TRANSCRIPTION_CHUNK_MAX_RETRIES, 5),
    baseMs,
    maxMs: Math.max(maxMs, baseMs),
  };
}

/** Minimum gap (ms) between transcription requests from `TRANSCRIPTION_MAX_RPM`. */
export function transcriptionMinIntervalMs(): number {
  const rpm = parsePositiveInt(process.env.TRANSCRIPTION_MAX_RPM, 60);
  return Math.ceil(60000 / rpm);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errorStatusCode(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    for (const key of ['statusCode', 'status', 'code']) {
      const v = obj[key];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
    }
  }
  return undefined;
}

const RATE_LIMIT_PATTERN =
  /\b(429|503)\b|resource_exhausted|too many requests|rate[ _-]?limit|quota|high demand|overload|unavailable|service is temporarily/i;

/**
 * True for transient provider errors worth retrying (rate limit / overload /
 * temporary unavailability). Auth, bad-audio, and other hard errors return
 * false so they fail fast.
 */
export function isRetryableTranscriptionError(err: unknown): boolean {
  const status = errorStatusCode(err);
  if (status === 429 || status === 503) return true;
  if (status === 400 || status === 401 || status === 403 || status === 404) return false;
  return RATE_LIMIT_PATTERN.test(errorMessage(err));
}

/**
 * Pull the provider's suggested retry delay (ms) out of an error, or null.
 * Handles Gemini "Please retry in 58.45s", structured `retryDelay: "58s"`,
 * and a numeric `Retry-After` response header (seconds).
 */
export function parseRetryDelayMs(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const headers = (err as Record<string, unknown>).responseHeaders;
    if (headers && typeof headers === 'object') {
      const raw = (headers as Record<string, unknown>)['retry-after'];
      const secs = typeof raw === 'string' ? Number.parseFloat(raw) : typeof raw === 'number' ? raw : NaN;
      if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    }
  }

  const msg = errorMessage(err);
  const patterns = [
    /retry in ([\d.]+)\s*s/i,
    /retryDelay["'\s:=]+([\d.]+)s/i,
    /retry[- ]after["'\s:=]+([\d.]+)/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m) {
      const secs = Number.parseFloat(m[1]);
      if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    }
  }
  return null;
}

/**
 * How long to wait (ms) before retry `attempt` (0-based). Honors the server's
 * hint when present (capped), otherwise exponential backoff base*3^attempt
 * (5s → 15s → 45s …) capped at `maxMs`.
 */
export function computeBackoffMs(attempt: number, config: BackoffConfig, serverHintMs: number | null): number {
  if (serverHintMs != null && serverHintMs >= 0) {
    return Math.min(serverHintMs, config.maxMs);
  }
  const exp = config.baseMs * Math.pow(3, Math.max(0, attempt));
  return Math.min(exp, config.maxMs);
}

/** A stateful pacer that enforces a minimum interval between awaited calls. */
export function createTranscriptionPacer(
  minIntervalMs: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): () => Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let last = 0;
  let started = false;
  return async function pace(): Promise<void> {
    if (started) {
      const elapsed = now() - last;
      if (elapsed < minIntervalMs) {
        await sleep(minIntervalMs - elapsed);
      }
    }
    started = true;
    last = now();
  };
}

/**
 * Transcribe one chunk with adaptive backoff. Retries retryable rate-limit /
 * overload errors up to `config.maxRetries`, honoring the server's suggested
 * delay; re-throws non-retryable errors immediately. Dependencies are
 * injectable for testing.
 */
export async function transcribeWithBackoff(
  audio: Buffer,
  opts: {
    transcribeFn?: (audio: Buffer, context?: TranscriptionContext) => Promise<{ text: string }>;
    sleep?: (ms: number) => Promise<void>;
    config?: BackoffConfig;
    context?: TranscriptionContext;
  } = {},
): Promise<{ text: string }> {
  const transcribeFn = opts.transcribeFn ?? transcribeAudio;
  const sleep = opts.sleep ?? defaultSleep;
  const config = opts.config ?? getBackoffConfig();

  let attempt = 0;
  while (true) {
    try {
      return await transcribeFn(audio, opts.context);
    } catch (err) {
      if (!isRetryableTranscriptionError(err) || attempt >= config.maxRetries) {
        throw err;
      }
      const delay = computeBackoffMs(attempt, config, parseRetryDelayMs(err));
      await sleep(delay);
      attempt += 1;
    }
  }
}
