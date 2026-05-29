'use client';

import { BlockBlobClient, AnonymousCredential } from '@azure/storage-blob';

interface VoiceSasResponse {
  sasUrl: string;
  blobPath: string;
  expiresAt: string;
}

export interface EnrolledVoiceSample {
  id: string;
  label: string;
  durationMs: number;
  source: string;
  exemplarCount: number;
  createdAt: string;
}

/**
 * Direct-to-blob enrollment upload, mirroring `uploadFileToBlob` but scoped to
 * the campaign voice-sample endpoints:
 *   1. ask the app for a voice upload URL (`POST .../voice-samples/sas`),
 *   2. PUT the recorded clip straight to Blob storage,
 *   3. finalize (`POST .../voice-samples`) so the app embeds + stores it.
 */
export async function uploadVoiceSample(
  campaignId: string,
  clip: Blob,
  label: string,
): Promise<EnrolledVoiceSample> {
  const mimetype = clip.type || 'audio/webm';

  const sasResponse = await fetch(`/api/campaigns/${campaignId}/voice-samples/sas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimetype, size: clip.size }),
  });
  if (!sasResponse.ok) {
    const error = await sasResponse.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to obtain voice upload URL');
  }
  const { sasUrl, blobPath } = (await sasResponse.json()) as VoiceSasResponse;

  const client = new BlockBlobClient(sasUrl, new AnonymousCredential());
  await client.uploadData(clip, {
    blobHTTPHeaders: { blobContentType: mimetype },
  });

  const finalizeResponse = await fetch(`/api/campaigns/${campaignId}/voice-samples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blobPath, label }),
  });
  const finalizeBody = await finalizeResponse.json().catch(() => ({}));
  if (!finalizeResponse.ok) {
    throw new Error(finalizeBody.error || 'Failed to save voice sample');
  }
  return finalizeBody.voiceSample as EnrolledVoiceSample;
}
