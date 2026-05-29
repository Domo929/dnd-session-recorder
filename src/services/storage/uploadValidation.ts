/** Audio MIME types accepted for upload (shared across every upload route). */
export const allowedMimeTypes = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mp4',
  'audio/aac',
  'audio/x-aac',
  'audio/flac',
  'audio/webm',
];

export function isAllowedMime(mimetype: string): boolean {
  return allowedMimeTypes.includes(mimetype);
}

/** Upload size ceiling in bytes. Default 2 GB now that bytes bypass the app server. */
export function maxFileSize(): number {
  return parseInt(process.env.MAX_FILE_SIZE || '2147483648', 10);
}
