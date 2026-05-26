import { randomBytes, createHash } from 'node:crypto';

/** 32 random bytes, base64url-encoded (43 chars). */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Stable hash for DB lookup; never store the raw token. */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
