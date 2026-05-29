import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  type ContainerClient,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import {
  buildBlobPath,
  UPLOAD_URL_TTL_MS,
  type BlobHead,
  type IssueUploadOptions,
  type IssuedUpload,
  type StorageBackend,
  type StorageService,
} from './types';

const DEFAULT_AUDIO_CONTAINER = 'audio-sessions';

/**
 * Shared block-blob plumbing for the Azure and Azurite backends. Only the
 * credential + SAS-minting differ between them; head/materialize/delete are
 * identical.
 */
export abstract class BlobStorageServiceBase implements StorageService {
  abstract readonly backend: StorageBackend;
  protected abstract readonly client: BlobServiceClient;
  protected readonly containerName: string;
  private ensured = false;

  constructor(containerName?: string) {
    this.containerName = containerName || process.env.AZURE_BLOB_AUDIO_CONTAINER || DEFAULT_AUDIO_CONTAINER;
  }

  protected container(): ContainerClient {
    return this.client.getContainerClient(this.containerName);
  }

  /** Real storage accounts provision the container via Bicep; dev/Azurite don't. */
  protected async ensureContainer(): Promise<void> {
    if (this.ensured) return;
    await this.container().createIfNotExists();
    this.ensured = true;
  }

  abstract issueUploadUrl(opts: IssueUploadOptions): Promise<IssuedUpload>;

  /** Builds the namespaced blob path + a fresh `{timestamp}-{uuid}` filename. */
  protected newBlobPath(userId: string, originalName: string): string {
    const ext = path.extname(originalName);
    return buildBlobPath(userId, `${Date.now()}-${uuidv4()}${ext}`);
  }

  async head(blobPath: string): Promise<BlobHead> {
    try {
      const props = await this.container().getBlockBlobClient(blobPath).getProperties();
      return { exists: true, size: props.contentLength ?? 0 };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { exists: false, size: 0 };
      }
      throw err;
    }
  }

  async materializeToTempFile(blobPath: string): Promise<string> {
    const tempPath = path.join(os.tmpdir(), `${randomUUID()}${path.extname(blobPath)}`);
    await this.container().getBlockBlobClient(blobPath).downloadToFile(tempPath);
    return tempPath;
  }

  async delete(blobPath: string): Promise<void> {
    await this.container().getBlockBlobClient(blobPath).deleteIfExists();
  }
}

/**
 * Production backend. Authenticates to the storage account with the App Service
 * managed identity (no account key, no secret to rotate) and mints short-lived
 * user-delegation SAS URLs scoped to a single blob, create+write only.
 */
export class AzureBlobStorageService extends BlobStorageServiceBase {
  readonly backend: StorageBackend = 'azure-blob';
  protected readonly client: BlobServiceClient;
  private readonly accountName: string;

  constructor(accountName?: string) {
    super();
    const name = accountName ?? process.env.AZURE_BLOB_ACCOUNT_NAME;
    if (!name) {
      throw new Error('AZURE_BLOB_ACCOUNT_NAME is required for the Azure Blob storage backend');
    }
    this.accountName = name;
    this.client = new BlobServiceClient(
      `https://${name}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
  }

  async issueUploadUrl(opts: IssueUploadOptions): Promise<IssuedUpload> {
    const blobPath = this.newBlobPath(opts.userId, opts.originalName);
    const startsOn = new Date(Date.now() - 5 * 60 * 1000); // 5 min skew tolerance
    const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_MS);

    const userDelegationKey = await this.client.getUserDelegationKey(startsOn, expiresAt);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName: blobPath,
        permissions: BlobSASPermissions.from({ create: true, write: true }),
        startsOn,
        expiresOn: expiresAt,
        protocol: SASProtocol.Https,
      },
      userDelegationKey,
      this.accountName,
    ).toString();

    const uploadUrl = `${this.container().getBlockBlobClient(blobPath).url}?${sas}`;
    return { uploadUrl, blobPath, expiresAt };
  }
}
