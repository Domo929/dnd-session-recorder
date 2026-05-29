export type StorageBackend = 'azure-blob' | 'azurite' | 'local';

export interface IssuedUpload {
  /** Time-limited URL the browser can PUT directly to. */
  uploadUrl: string;
  /** Stable identifier persisted as `Upload.path` for blob-backed rows. */
  blobPath: string;
  /** When `uploadUrl` stops working. */
  expiresAt: Date;
}

export interface IssuedReadUrl {
  /** Time-limited read-only URL (e.g. for the diarization container to curl). */
  url: string;
  /** When `url` stops working. */
  expiresAt: Date;
}

export interface BlobHead {
  exists: boolean;
  /** Size in bytes; 0 when the blob does not exist. */
  size: number;
}

export interface IssueUploadOptions {
  userId: string;
  originalName: string;
  mimetype: string;
  size: number;
}

export interface StorageService {
  readonly backend: StorageBackend;

  /** Issue a time-limited upload URL the browser can PUT directly to. */
  issueUploadUrl(opts: IssueUploadOptions): Promise<IssuedUpload>;

  /**
   * Issue a time-limited, read-only URL for an existing blob (e.g. for the
   * diarization container to download the session audio). Fails closed on the
   * local backend.
   */
  issueReadUrl(blobPath: string, ttlMs: number): Promise<IssuedReadUrl>;

  /**
   * Issue a time-limited upload URL for an explicit, caller-chosen blob path
   * (e.g. a voice clip whose key is derived from a database id). The caller is
   * responsible for namespacing/validating the path before passing it in.
   */
  issueUploadUrlForPath(blobPath: string): Promise<IssuedUpload>;

  /** Verify a previously-issued upload actually landed. Returns the real size. */
  head(blobPath: string): Promise<BlobHead>;

  /**
   * Upload a local file to an explicit blob path (server-side, no browser SAS).
   * Used by the local→blob migration script. Fails closed on the local backend.
   */
  uploadFile(blobPath: string, localPath: string): Promise<void>;

  /** Download to a unique temp path. Caller must delete when done. */
  materializeToTempFile(blobPath: string): Promise<string>;

  /** Permanently delete. Used during deletion + on a failed complete/probe. */
  delete(blobPath: string): Promise<void>;
}

/** 30 minutes, the SAS / upload-URL TTL. */
export const UPLOAD_URL_TTL_MS = 30 * 60 * 1000;

/**
 * Blob naming convention: user-namespaced so cross-user access is
 * path-impossible even before RBAC. Keeps the existing `${Date.now()}-${uuid}`
 * filename convention.
 */
export function buildBlobPath(userId: string, filename: string): string {
  return `uploads/${userId}/${filename}`;
}

/** True when `blobPath` belongs to `userId` (defends the complete/SAS routes). */
export function blobPathOwnedBy(blobPath: string, userId: string): boolean {
  return blobPath.startsWith(`uploads/${userId}/`);
}
