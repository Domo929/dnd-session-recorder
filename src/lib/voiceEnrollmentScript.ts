/**
 * A read-aloud script for voice enrollment. Reading a fixed, phonetically rich
 * passage gives the speaker-embedding model a consistent, high-coverage seed:
 * the passage deliberately exercises plosives, fricatives, sibilants, affricates,
 * nasals, liquids, glides, a spread of vowels, and a spoken number — while
 * staying on-theme so it's pleasant to read.
 *
 * Kept as a plain module (no React, no server-only imports) so it can be used by
 * the recorder UI and unit-tested in isolation. Comfortably readable in ~20-30s,
 * which sits above the 8s enrollment minimum and under the 60s cap defined in
 * `voiceRecording.ts`.
 */

export const VOICE_ENROLLMENT_SCRIPT_TITLE = 'Read this aloud while recording';

export const VOICE_ENROLLMENT_SCRIPT =
  "The bold rogue crept through the haunted crypt, jingling five silver keys. " +
  "\u201CBy Moradin's beard,\u201D she whispered, \u201Cthis quest will vex even a wizard!\u201D " +
  "Thunder cracked above the jagged peaks as the dragon's amber eyes blazed. " +
  "We gathered our courage, quaffed a healing potion, and charged the shadowy throne \u2014 " +
  "laughing, shouting, ready for whatever the dice might roll.";
