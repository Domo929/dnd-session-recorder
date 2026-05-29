import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { BlobStorageServiceBase } from './azure';
import {
  UPLOAD_URL_TTL_MS,
  type IssueUploadOptions,
  type IssuedUpload,
  type StorageBackend,
} from './types';

function parseConnectionString(connStr: string): { accountName: string; accountKey: string } {
  const parts = Object.fromEntries(
    connStr
      .split(';')
      .filter(Boolean)
      .map((kv) => {
        const idx = kv.indexOf('=');
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      }),
  );
  const accountName = parts['AccountName'];
  const accountKey = parts['AccountKey'];
  if (!accountName || !accountKey) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING must contain AccountName and AccountKey');
  }
  return { accountName, accountKey };
}

/**
 * Local dev + smoke backend (Azurite). Identical SDK code to Azure, but
 * authenticates with the connection-string shared key and mints shared-key SAS
 * (Azurite speaks plain HTTP, so the SAS permits HTTP as well as HTTPS).
 */
export class AzuriteStorageService extends BlobStorageServiceBase {
  readonly backend: StorageBackend = 'azurite';
  protected readonly client: BlobServiceClient;
  private readonly sharedKey: StorageSharedKeyCredential;

  constructor(connectionString?: string) {
    super();
    const connStr = connectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING is required for the Azurite storage backend');
    }
    const { accountName, accountKey } = parseConnectionString(connStr);
    this.client = BlobServiceClient.fromConnectionString(connStr);
    this.sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
  }

  async issueUploadUrl(opts: IssueUploadOptions): Promise<IssuedUpload> {
    await this.ensureContainer();
    const blobPath = this.newBlobPath(opts.userId, opts.originalName);
    const startsOn = new Date(Date.now() - 5 * 60 * 1000);
    const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_MS);

    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName: blobPath,
        permissions: BlobSASPermissions.from({ create: true, write: true }),
        startsOn,
        expiresOn: expiresAt,
        protocol: SASProtocol.HttpsAndHttp,
      },
      this.sharedKey,
    ).toString();

    const uploadUrl = `${this.container().getBlockBlobClient(blobPath).url}?${sas}`;
    return { uploadUrl, blobPath, expiresAt };
  }
}
