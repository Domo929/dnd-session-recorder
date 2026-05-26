import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

// Inline audio payloads must stay below the Gemini ~20MB request cap.
// Use the same headroom (18MB) the OpenAI path already uses for Whisper.
export const INLINE_AUDIO_CHUNK_MB = 18;

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

export function audioMimeFor(filePath: string): string {
  return AUDIO_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'audio/mpeg';
}

/**
 * Splits an audio file into ~chunkSizeMB pieces using ffmpeg.
 * Returns the original path in a single-element array when no split is needed.
 */
export async function splitAudioBySize(
  inputPath: string,
  chunkSizeMB: number,
): Promise<string[]> {
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

export function cleanupChunks(chunkPaths: string[], originalPath: string): void {
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
