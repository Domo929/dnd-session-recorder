import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/lib/logger';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

export interface AudioChunk {
  path: string;
  index: number;
  sizeBytes: number;
}

export interface SplitOptions {
  /** Max chunk size in MB. Defaults to 24 (just under Whisper's 25MB limit). */
  maxChunkSizeMB?: number;
  /** Output directory for chunks. Defaults to same directory as input file. */
  outputDir?: string;
}

/** Parse an FFmpeg `timemark` ("HH:MM:SS.cs") into seconds. */
function parseTimemark(timemark: string): number {
  const match = /^(\d+):(\d{2}):(\d{2})(\.\d+)?$/.exec(timemark.trim());
  if (!match) {
    const asNumber = Number(timemark);
    return Number.isFinite(asNumber) ? asNumber : NaN;
  }
  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    (fraction ? Number(fraction) : 0)
  );
}

/**
 * Measure duration by fully decoding the stream to a null sink. Streamed
 * WebM/Ogg clips from the browser's `MediaRecorder` routinely omit a
 * container-level duration (it's unknown while the recording is still being
 * written), so `ffprobe` can't report one. Decoding lets FFmpeg count the
 * actual decoded time.
 */
function measureDurationByDecoding(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let lastTime = 0;
    ffmpeg(filePath)
      .outputOptions(['-f', 'null'])
      .output(process.platform === 'win32' ? 'NUL' : '/dev/null')
      .on('progress', (progress: { timemark?: string }) => {
        if (progress?.timemark) {
          const seconds = parseTimemark(progress.timemark);
          if (Number.isFinite(seconds) && seconds > lastTime) lastTime = seconds;
        }
      })
      .on('end', () => {
        if (lastTime > 0) resolve(lastTime);
        else reject(new Error('Could not determine audio duration'));
      })
      .on('error', (err: Error) =>
        reject(new Error(`Failed to decode audio duration: ${err.message}`)),
      )
      .run();
  });
}

/**
 * Get audio file duration in seconds using FFmpeg. Falls back to decoding the
 * stream when the container reports no duration (e.g. `MediaRecorder` WebM).
 */
export function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to probe audio file: ${err.message}`));
        return;
      }

      const duration = metadata.format?.duration;
      if (duration && Number.isFinite(duration) && duration > 0) {
        resolve(duration);
        return;
      }

      measureDurationByDecoding(filePath).then(resolve, reject);
    });
  });
}

/**
 * Create a single audio chunk using FFmpeg.
 */
function createChunk(
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(duration)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
      .run();
  });
}

/**
 * Extract a short clip from an audio file (used for unknown-speaker snippets).
 * Re-encodes to Opus in an Ogg container so the clip is small and broadly
 * playable. `startSec`/`durationSec` are clamped to non-negative.
 */
export function extractAudioClip(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(Math.max(0, startSec))
      .setDuration(Math.max(0, durationSec))
      .audioCodec('libopus')
      .format('ogg')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
      .run();
  });
}

/**
 * Split an audio file into chunks by size.
 *
 * Uses FFmpeg to split audio files into approximately equal chunks
 * based on duration proportional to file size. Chunks are created
 * in parallel for speed.
 *
 * @returns Array of chunk information including paths, indices, and sizes
 * @throws If the input file doesn't exist or FFmpeg fails
 */
export async function splitAudioBySize(
  inputPath: string,
  options: SplitOptions = {}
): Promise<AudioChunk[]> {
  const {
    maxChunkSizeMB = 24,
    outputDir = path.dirname(inputPath),
  } = options;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Audio file not found: ${inputPath}`);
  }

  const stats = fs.statSync(inputPath);
  const totalSize = stats.size;
  const chunkSizeBytes = maxChunkSizeMB * 1024 * 1024;
  const numChunks = Math.ceil(totalSize / chunkSizeBytes);

  if (numChunks === 1) {
    logger.debug('Audio file under size limit, no split needed', {
      maxChunkSizeMB,
      path: inputPath,
    });
    return [{ path: inputPath, index: 0, sizeBytes: totalSize }];
  }

  const duration = await getAudioDuration(inputPath);
  const chunkDuration = duration / numChunks;
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);

  logger.info('Splitting audio file into chunks', {
    path: inputPath,
    numChunks,
    maxChunkSizeMB,
    chunkDuration: chunkDuration.toFixed(2),
  });

  // Create all chunks in parallel (matching existing behavior)
  const chunkInfos: { outputPath: string; index: number }[] = [];
  const splitPromises: Promise<void>[] = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkDuration;
    const outputPath = path.join(outputDir, `${base}_chunk${i}${ext}`);
    chunkInfos.push({ outputPath, index: i });

    splitPromises.push(createChunk(inputPath, outputPath, start, chunkDuration));
  }

  await Promise.all(splitPromises);

  // Gather chunk metadata
  const chunks: AudioChunk[] = chunkInfos.map(({ outputPath, index }) => {
    const chunkStats = fs.statSync(outputPath);
    logger.debug('Audio chunk created', { output: outputPath });
    return {
      path: outputPath,
      index,
      sizeBytes: chunkStats.size,
    };
  });

  return chunks;
}

/**
 * Clean up chunk files, skipping the original input file.
 */
export function cleanupChunkFiles(chunkPaths: string[], originalPath: string): void {
  for (const p of chunkPaths) {
    if (p !== originalPath && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        logger.error('Chunk cleanup failed', err as Error, { path: p });
      }
    }
  }
}

/**
 * Validate an audio file exists and extract metadata.
 */
export async function validateAudioFile(filePath: string): Promise<{
  isValid: boolean;
  error?: string;
  metadata?: {
    duration: number;
    format: string;
    sizeBytes: number;
  };
}> {
  try {
    if (!fs.existsSync(filePath)) {
      return { isValid: false, error: 'File not found' };
    }

    const stats = fs.statSync(filePath);
    const duration = await getAudioDuration(filePath);

    const format = await new Promise<string>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.format_name || 'unknown');
      });
    });

    return {
      isValid: true,
      metadata: {
        duration,
        format,
        sizeBytes: stats.size,
      },
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Resolve an upload file path, checking multiple locations.
 *
 * Handles legacy file paths that may or may not include the uploads/ directory prefix.
 */
export function resolveUploadPath(filename: string): string | null {
  // Try exact path first
  if (fs.existsSync(filename)) {
    return filename;
  }

  // Try with uploads/ prefix
  const withPrefix = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(withPrefix)) {
    return withPrefix;
  }

  // Try without uploads/ prefix (if filename starts with it)
  if (filename.startsWith('uploads/')) {
    const withoutPrefix = filename.replace(/^uploads\//, '');
    const resolved = path.join(UPLOAD_DIR, withoutPrefix);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
}
