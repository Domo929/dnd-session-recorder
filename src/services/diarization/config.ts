/**
 * Dispatcher configuration (design §4). All knobs are env-overridable; the
 * defaults match the design's cost guardrails.
 */
export interface DispatchConfig {
  maxDailyUsd: number;
  maxConcurrent: number;
  maxPerCampaign: number;
  regions: string[];
  image: string | null;
  /** Per-session cost estimate recorded against a dispatched job (budgeting). */
  estimatedCostUsd: number;
  /** Public base URL the container posts results back to. */
  callbackBaseUrl: string | null;
  /** Read-SAS lifetime for the audio handed to the container. */
  sasTtlMs: number;
  /** ACI resource group / region plumbing for the real client. */
  subscriptionId: string | null;
  resourceGroup: string | null;
  /** GPU SKU requested for the container group (design: T4). */
  gpuSku: string;
  /** HuggingFace token for the gated pyannote model (passed to the container). */
  huggingFaceToken: string | null;
}

const DEFAULT_REGIONS = ['centralus', 'westus2', 'eastus2'];

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getDispatchConfig(env: NodeJS.ProcessEnv = process.env): DispatchConfig {
  const regions = (env.DIARIZATION_REGIONS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  return {
    maxDailyUsd: num(env.DIARIZATION_MAX_DAILY_USD, 5),
    maxConcurrent: num(env.DIARIZATION_MAX_CONCURRENT, 3),
    maxPerCampaign: num(env.DIARIZATION_MAX_PER_CAMPAIGN, 1),
    regions: regions.length > 0 ? regions : DEFAULT_REGIONS,
    image: env.DIARIZATION_IMAGE || null,
    estimatedCostUsd: num(env.DIARIZATION_COST_PER_SESSION_USD, 0.3),
    callbackBaseUrl: env.DIARIZATION_CALLBACK_BASE_URL || env.NEXTAUTH_URL || null,
    sasTtlMs: num(env.DIARIZATION_SAS_TTL_MINUTES, 120) * 60 * 1000,
    subscriptionId: env.AZURE_SUBSCRIPTION_ID || null,
    resourceGroup: env.DIARIZATION_ACI_RESOURCE_GROUP || null,
    gpuSku: env.DIARIZATION_GPU_SKU || 'T4',
    huggingFaceToken: env.HUGGINGFACE_TOKEN || null,
  };
}

/** Whether the dispatcher has the minimum config to actually launch containers. */
export function isDispatchConfigured(config: DispatchConfig): boolean {
  return !!(
    config.image &&
    config.callbackBaseUrl &&
    config.subscriptionId &&
    config.resourceGroup
  );
}
