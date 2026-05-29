/**
 * Blob naming conventions for the speaker-labels voice library
 * (design: docs/plans/2026-05-27-speaker-labels-design.md §2/§4). Voice clips
 * live in their own container (`AZURE_BLOB_VOICE_CONTAINER`, default
 * `voice-samples`); enrollment/promoted clips are user-namespaced, and
 * unknown-cluster snippets are session-namespaced.
 */

/** Default container name for voice clips; override via env in the storage layer. */
export const VOICE_CONTAINER = 'voice-samples';

/** Enrollment / promoted voice clip: `voice-samples/{userId}/{sampleId}.opus`. */
export function buildVoiceSamplePath(userId: string, sampleId: string): string {
  return `${VOICE_CONTAINER}/${userId}/${sampleId}.opus`;
}

/** True when a voice clip belongs to `userId`. */
export function voiceSamplePathOwnedBy(blobPath: string, userId: string): boolean {
  return blobPath.startsWith(`${VOICE_CONTAINER}/${userId}/`);
}

/**
 * Unknown-cluster snippet: `voice-samples/clusters/{sessionId}/{clusterIdx}.opus`.
 * Promoted to a permanent voice clip on lazy-tag (the row's path is reused).
 */
export function buildClusterSnippetPath(sessionId: string, clusterIdx: number): string {
  return `${VOICE_CONTAINER}/clusters/${sessionId}/${clusterIdx}.opus`;
}

/** True when a blob path is a cluster snippet (vs a user-owned voice clip). */
export function isClusterSnippetPath(blobPath: string): boolean {
  return blobPath.startsWith(`${VOICE_CONTAINER}/clusters/`);
}
