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
  // Reject control characters (e.g. newlines) so a base-type match can't be
  // smuggled past via header-injection-style input.
  if (/[\u0000-\u001f\u007f]/.test(mimetype)) {
    return false;
  }
  // MediaRecorder (and some browsers) tag the type with parameters, e.g.
  // "audio/webm;codecs=opus" or "audio/mp4; codecs=mp4a.40.2". Match on the base
  // type only, normalizing case/whitespace, so codec-qualified types are accepted.
  const baseType = mimetype.split(';')[0].trim().toLowerCase();
  return allowedMimeTypes.includes(baseType);
}

/** Upload size ceiling in bytes. Default 2 GB now that bytes bypass the app server. */
export function maxFileSize(): number {
  return parseInt(process.env.MAX_FILE_SIZE || '2147483648', 10);
}
