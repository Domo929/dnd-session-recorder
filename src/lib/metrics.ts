/**
 * Prometheus metrics registry and instrumentation helpers.
 *
 * Runtime (rate/latency/cost) metrics live here and are exposed at
 * `GET /api/metrics` for Prometheus to scrape. Business/state metrics (user
 * counts, sessions-by-status, etc.) are intentionally NOT mirrored here — those
 * are charted directly from Postgres in Grafana, which avoids counter resets on
 * container restart and keeps this module cheap.
 *
 * The whole registry is memoized on `globalThis` so Next.js HMR and multiple
 * route bundles reuse one set of collectors instead of throwing on duplicate
 * metric registration (same pattern as `src/lib/prisma.ts`).
 */
import {
  Registry,
  Counter,
  Histogram,
  collectDefaultMetrics,
  type Metric,
} from 'prom-client';
import type { NextRequest } from 'next/server';
import { MODEL_PRICING, CHARS_PER_TOKEN } from '@/lib/summaryCost';

export interface AppMetrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  aiRequests: Counter<'provider' | 'model' | 'kind' | 'status'>;
  aiDuration: Histogram<'provider' | 'model' | 'kind'>;
  aiTokens: Counter<'provider' | 'model' | 'kind' | 'type'>;
  aiCostUsd: Counter<'provider' | 'model' | 'kind'>;
  voiceMatches: Counter<'confidence'>;
  voiceMatchScore: Histogram<'confidence'>;
  voiceLearned: Counter<string>;
  diarizationCallbacks: Counter<'status'>;
}

declare global {
  var __appMetrics: AppMetrics | undefined;
}

const PREFIX = 'dndrec_';

function build(): AppMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'dnd-session-recorder' });

  // Node process metrics: CPU, memory, event-loop lag, GC, handles.
  collectDefaultMetrics({ register: registry, prefix: PREFIX });

  const httpRequests = new Counter({
    name: `${PREFIX}http_requests_total`,
    help: 'HTTP requests handled, by route and outcome.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: `${PREFIX}http_request_duration_seconds`,
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  const aiRequests = new Counter({
    name: `${PREFIX}ai_requests_total`,
    help: 'AI provider calls, by kind (transcription/summary/...) and outcome.',
    labelNames: ['provider', 'model', 'kind', 'status'] as const,
    registers: [registry],
  });

  const aiDuration = new Histogram({
    name: `${PREFIX}ai_request_duration_seconds`,
    help: 'AI provider call latency in seconds.',
    labelNames: ['provider', 'model', 'kind'] as const,
    buckets: [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300],
    registers: [registry],
  });

  const aiTokens = new Counter({
    name: `${PREFIX}ai_tokens_total`,
    help: 'AI tokens consumed (type=input|output), actual when reported else estimated.',
    labelNames: ['provider', 'model', 'kind', 'type'] as const,
    registers: [registry],
  });

  const aiCostUsd = new Counter({
    name: `${PREFIX}ai_cost_usd_total`,
    help: 'Estimated AI spend in USD, derived from token usage and model pricing.',
    labelNames: ['provider', 'model', 'kind'] as const,
    registers: [registry],
  });

  const voiceMatches = new Counter({
    name: `${PREFIX}voice_matches_total`,
    help: 'Diarized clusters resolved against campaign voices, by confidence (high/low/none).',
    labelNames: ['confidence'] as const,
    registers: [registry],
  });

  const voiceMatchScore = new Histogram({
    name: `${PREFIX}voice_match_score`,
    help: 'Best cosine similarity score per cluster match, by confidence.',
    labelNames: ['confidence'] as const,
    buckets: [0, 0.3, 0.45, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1],
    registers: [registry],
  });

  const voiceLearned = new Counter({
    name: `${PREFIX}voice_exemplars_learned_total`,
    help: 'High-confidence auto-matches folded back into a voice fingerprint.',
    registers: [registry],
  });

  const diarizationCallbacks = new Counter({
    name: `${PREFIX}diarization_callbacks_total`,
    help: 'Diarization callbacks processed, by outcome.',
    labelNames: ['status'] as const,
    registers: [registry],
  });

  return {
    registry,
    httpRequests,
    httpDuration,
    aiRequests,
    aiDuration,
    aiTokens,
    aiCostUsd,
    voiceMatches,
    voiceMatchScore,
    voiceLearned,
    diarizationCallbacks,
  };
}

export const metrics: AppMetrics = globalThis.__appMetrics ?? build();
globalThis.__appMetrics = metrics;

/** Cost in USD for a token usage against a known `provider:model`, else 0. */
export function estimateTokenCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICING[`${provider}:${model}`];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M
  );
}

/** Rough token estimate from character count (mirrors summaryCost heuristic). */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * Record one AI call. `usage` is the SDK's reported token usage when available;
 * when absent, callers may pass estimated counts. Cost is only added for models
 * with known pricing.
 */
export function recordAiCall(args: {
  provider: string;
  model: string;
  kind: string;
  status: 'success' | 'error';
  durationSeconds: number;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const { provider, model, kind, status, durationSeconds } = args;
  const labels = { provider, model, kind };
  metrics.aiRequests.inc({ ...labels, status });
  metrics.aiDuration.observe(labels, durationSeconds);

  const inputTokens = args.inputTokens ?? 0;
  const outputTokens = args.outputTokens ?? 0;
  if (inputTokens > 0) metrics.aiTokens.inc({ ...labels, type: 'input' }, inputTokens);
  if (outputTokens > 0) metrics.aiTokens.inc({ ...labels, type: 'output' }, outputTokens);

  const cost = estimateTokenCostUsd(provider, model, inputTokens, outputTokens);
  if (cost > 0) metrics.aiCostUsd.inc(labels, cost);
}

/** Record one diarized-cluster match outcome. */
export function recordVoiceMatch(confidence: 'high' | 'low' | 'none', score: number | null): void {
  metrics.voiceMatches.inc({ confidence });
  if (typeof score === 'number' && Number.isFinite(score)) {
    metrics.voiceMatchScore.observe({ confidence }, score);
  }
}

/**
 * Wrap an App Router handler so every invocation records request count + latency
 * labeled by a stable `route` template. Apply per route:
 *   export const POST = withHttpMetrics('/api/x', handler);
 * `finally` records even when the handler throws (status defaults to 500).
 */
export function withHttpMetrics<Ctx>(
  route: string,
  handler: (request: NextRequest, context: Ctx) => Promise<Response>,
): (request: NextRequest, context: Ctx) => Promise<Response> {
  return async (request, context) => {
    const start = Date.now();
    const method = request.method;
    let status = 500;
    try {
      const res = await handler(request, context);
      status = res.status;
      return res;
    } finally {
      const labels = { method, route, status: String(status) };
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(labels, (Date.now() - start) / 1000);
    }
  };
}

export type AnyMetric = Metric<string>;
