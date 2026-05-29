import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/lib/logger';
import {
  EMBEDDING_DIMENSIONS,
  l2Normalize,
  type VoiceEmbeddingService,
} from './types';

/** Sample rate (Hz) expected by the ECAPA-TDNN speaker-embedding model. */
const TARGET_SAMPLE_RATE = 16_000;

/**
 * Decode an encoded audio clip to mono 16 kHz 32-bit float PCM samples using
 * ffmpeg, returning the raw samples as a Float32Array.
 */
async function decodeToPcm(audio: Buffer): Promise<Float32Array> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-embed-'));
  const inPath = path.join(tmpDir, 'in');
  const outPath = path.join(tmpDir, 'out.f32le');
  fs.writeFileSync(inPath, audio);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .audioChannels(1)
        .audioFrequency(TARGET_SAMPLE_RATE)
        .format('f32le')
        .output(outPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(new Error(`ffmpeg decode failed: ${err.message}`)))
        .run();
    });
    const raw = fs.readFileSync(outPath);
    const samples = new Float32Array(raw.length / 4);
    for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4);
    return samples;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Real speaker-embedding backend backed by an ONNX ECAPA-TDNN model executed
 * via the optional, glibc-only `onnxruntime-node` package.
 *
 * Both the package and the model file are loaded lazily so the app never fails
 * at import time when running with the mock backend (the default everywhere
 * except the dedicated GPU/diarization environment provisioned in SL-7).
 */
export class OnnxVoiceEmbeddingService implements VoiceEmbeddingService {
  readonly backend = 'onnx' as const;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  private readonly modelPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionPromise: Promise<any> | null = null;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getSession(): Promise<any> {
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = (async () => {
      if (!fs.existsSync(this.modelPath)) {
        throw new Error(
          `VOICE_EMBEDDING_MODEL_PATH points at a missing file: ${this.modelPath}. ` +
            'Bundle the ECAPA-TDNN ONNX model or set MOCK_AI_SERVICES=true to use the mock backend.',
        );
      }
      let ort: typeof import('onnxruntime-node');
      try {
        ort = await import('onnxruntime-node');
      } catch (err) {
        throw new Error(
          'The real voice-embedding backend requires the optional "onnxruntime-node" package ' +
            '(glibc-only; not installable on musl/alpine). Install it on a supported host or set ' +
            'MOCK_AI_SERVICES=true. ' +
            `Original import error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      logger.info(`[voiceEmbedding] loading ONNX model: ${this.modelPath}`);
      return ort.InferenceSession.create(this.modelPath);
    })();
    return this.sessionPromise;
  }

  async embedClip(audio: Buffer): Promise<Float32Array> {
    const session = await this.getSession();
    const ort = await import('onnxruntime-node');
    const samples = await decodeToPcm(audio);
    if (samples.length === 0) {
      throw new Error('Decoded audio produced no samples; clip may be empty or corrupt');
    }

    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const tensor = new ort.Tensor('float32', samples, [1, samples.length]);
    const result = await session.run({ [inputName]: tensor });
    const out = result[outputName];
    const data = out.data as Float32Array;

    if (data.length !== this.dimensions) {
      throw new Error(
        `Voice-embedding model produced ${data.length} dims, expected ${this.dimensions}`,
      );
    }
    return l2Normalize(Float32Array.from(data));
  }
}
