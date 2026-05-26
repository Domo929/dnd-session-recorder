import fs from 'fs';
import path from 'path';
import type { TranscriptionService } from './types';

const DEFAULT_MODEL = 'base.en';

/**
 * Local whisper.cpp transcription via the optional `nodejs-whisper` package.
 *
 * The package is loaded lazily inside transcribe() so the rest of the app
 * doesn't fail at import time when the optional dep isn't installed
 * (build tooling: make/cmake/g++/python3 + ffmpeg required on the host).
 */
export class LocalWhisperTranscriptionService implements TranscriptionService {
  readonly name = 'whisper-local' as const;

  async transcribe(audioPath: string): Promise<string> {
    const modelName = process.env.WHISPER_MODEL || DEFAULT_MODEL;
    // Only override the model location when the user explicitly sets the env var.
    // When unset, nodejs-whisper uses its bundled default
    // (node_modules/nodejs-whisper/cpp/whisper.cpp/models/), which is also where
    // `npx nodejs-whisper download` puts files — so the two stay in sync without
    // duplicating downloads.
    const modelRootPath = process.env.WHISPER_MODELS_DIR
      ? path.resolve(process.env.WHISPER_MODELS_DIR)
      : undefined;
    const withCuda = (process.env.WHISPER_USE_CUDA ?? '').toLowerCase() === 'true';

    console.log(
      `[AI] Using local whisper.cpp model: ${modelName} (modelsDir=${modelRootPath ?? '<package default>'}, cuda=${withCuda})`,
    );

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

    // nodewhisper resolves to the transcript content for the configured output.
    // It also writes a sibling `<audio>.wav.txt` next to the input.
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
}
