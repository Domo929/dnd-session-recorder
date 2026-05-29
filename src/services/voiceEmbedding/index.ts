import { logger } from '@/lib/logger';
import { MockVoiceEmbeddingService } from './mock';
import { OnnxVoiceEmbeddingService } from './onnx';
import type { VoiceEmbeddingService } from './types';

function mockEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.MOCK_AI_SERVICES ?? '').toLowerCase() === 'true';
}

/**
 * Pure backend selection — the deterministic mock is used unless a real model
 * is configured (VOICE_EMBEDDING_MODEL_PATH) and mocking is not forced. The
 * mock keeps every non-GPU environment (local dev, smoke, CI, the default
 * Azure App Service image) dependency-free. Exported separately so it can be
 * unit-tested without touching the module-level singleton.
 */
export function createVoiceEmbeddingService(
  env: NodeJS.ProcessEnv = process.env,
): VoiceEmbeddingService {
  const modelPath = env.VOICE_EMBEDDING_MODEL_PATH;
  if (mockEnabled(env) || !modelPath) {
    return new MockVoiceEmbeddingService();
  }
  return new OnnxVoiceEmbeddingService(modelPath);
}

let instance: VoiceEmbeddingService | null = null;

export function getVoiceEmbeddingService(): VoiceEmbeddingService {
  if (!instance) {
    instance = createVoiceEmbeddingService();
    logger.info(`[voiceEmbedding] backend=${instance.backend}`);
  }
  return instance;
}

/** Test-only: drop the cached singleton so a new env can be selected. */
export function resetVoiceEmbeddingService(): void {
  instance = null;
}

export type { VoiceEmbeddingService, VoiceEmbeddingBackend } from './types';
export { EMBEDDING_DIMENSIONS, l2Normalize } from './types';
export { MockVoiceEmbeddingService } from './mock';
export { OnnxVoiceEmbeddingService } from './onnx';
