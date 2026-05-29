import { logger } from '@/lib/logger';
import type { DispatchConfig } from './config';

export interface AciCreateArgs {
  jobId: string;
  region: string;
  audioUrl: string;
  callbackUrl: string;
  hmacSecret: string;
}

export type AciStatus = 'Running' | 'Terminated' | 'NotFound';

/**
 * Minimal Azure Container Instances surface the dispatcher needs. Abstracted so
 * the dispatch/cleanup orchestration is fully testable with a fake, and the real
 * Azure SDK is only loaded when the dispatcher is actually configured.
 */
export interface AciClient {
  /** Create a GPU container group in `region`. Returns its ARM resource id. */
  create(args: AciCreateArgs): Promise<{ aciResourceId: string }>;
  /** Current provisioning/instance state of a container group. */
  getStatus(aciResourceId: string): Promise<AciStatus>;
  /** Delete a container group (idempotent). */
  delete(aciResourceId: string): Promise<void>;
}

/**
 * Real ACI client. The Azure ARM SDK is an optional dependency and is imported
 * lazily so normal installs/builds (and unit tests) never need it; it is only
 * present in the deployed environment. T4 GPU, image + env per design §4.
 */
class AzureAciClient implements AciClient {
  constructor(
    private readonly subscriptionId: string,
    private readonly resourceGroup: string,
    private readonly image: string,
    private readonly gpuSku: string,
    private readonly huggingFaceToken: string | null,
  ) {}

  private async sdk() {
    const { ContainerInstanceManagementClient } = await import(
      '@azure/arm-containerinstance'
    );
    const { DefaultAzureCredential } = await import('@azure/identity');
    return new ContainerInstanceManagementClient(
      new DefaultAzureCredential(),
      this.subscriptionId,
    );
  }

  private groupName(jobId: string): string {
    return `diarization-${jobId}`;
  }

  async create(args: AciCreateArgs): Promise<{ aciResourceId: string }> {
    const client = await this.sdk();
    const name = this.groupName(args.jobId);
    const result = await client.containerGroups.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      name,
      {
        location: args.region,
        osType: 'Linux',
        restartPolicy: 'Never',
        sku: 'Standard',
        containers: [
          {
            name: 'diarization',
            image: this.image,
            resources: {
              requests: {
                cpu: 4,
                memoryInGB: 16,
                gpu: { count: 1, sku: this.gpuSku },
              },
            },
            environmentVariables: [
              { name: 'JOB_ID', value: args.jobId },
              { name: 'AUDIO_URL', secureValue: args.audioUrl },
              { name: 'CALLBACK_URL', value: args.callbackUrl },
              { name: 'HMAC_SECRET', secureValue: args.hmacSecret },
              // pyannote 3.1 is a gated HF model; the token (when configured)
              // lets the container download it at runtime.
              ...(this.huggingFaceToken
                ? [{ name: 'HUGGINGFACE_TOKEN', secureValue: this.huggingFaceToken }]
                : []),
            ],
          },
        ],
      },
    );
    if (!result.id) throw new Error('ACI create returned no resource id');
    return { aciResourceId: result.id };
  }

  async getStatus(aciResourceId: string): Promise<AciStatus> {
    const client = await this.sdk();
    const name = aciResourceId.split('/').pop()!;
    try {
      const group = await client.containerGroups.get(this.resourceGroup, name);
      const state = group.instanceView?.state ?? group.provisioningState ?? '';
      if (/terminated|succeeded|failed/i.test(state)) return 'Terminated';
      return 'Running';
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return 'NotFound';
      throw err;
    }
  }

  async delete(aciResourceId: string): Promise<void> {
    const client = await this.sdk();
    const name = aciResourceId.split('/').pop()!;
    await client.containerGroups.beginDeleteAndWait(this.resourceGroup, name).catch((err) => {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    });
  }
}

/**
 * Build the real ACI client, or null when the dispatcher isn't configured for
 * this environment (the dispatcher then stays dormant — fail closed).
 */
export function createAciClient(config: DispatchConfig): AciClient | null {
  if (!config.subscriptionId || !config.resourceGroup || !config.image) {
    logger.info('[diarization] ACI client not configured; dispatcher dormant');
    return null;
  }
  return new AzureAciClient(
    config.subscriptionId,
    config.resourceGroup,
    config.image,
    config.gpuSku,
    config.huggingFaceToken,
  );
}
