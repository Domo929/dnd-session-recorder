/**
 * Speaker-aware transcript helpers shared by the transcript view, the
 * speaker-aware summary prompt, and the NPC inference prompt (design Section 5).
 *
 * Pure functions only — no DB or React.
 */

export interface SpeakerRow {
  speakerClusterId: string | null;
  startTime: number;
  text: string;
}

export interface SpeakerTurn {
  speakerClusterId: string | null;
  startTime: number;
  text: string;
}

/** Format seconds as `mm:ss` (or `h:mm:ss` past an hour). */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

/**
 * Collapse consecutive rows from the same speaker cluster into a single turn,
 * joining their text with spaces. Order is preserved; a null cluster (no
 * attribution) only groups with adjacent null rows.
 */
export function groupTurns(rows: SpeakerRow[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const row of rows) {
    const last = turns[turns.length - 1];
    if (last && last.speakerClusterId === row.speakerClusterId) {
      const text = row.text.trim();
      last.text = text ? `${last.text} ${text}`.trim() : last.text;
    } else {
      turns.push({
        speakerClusterId: row.speakerClusterId,
        startTime: row.startTime,
        text: row.text.trim(),
      });
    }
  }
  return turns;
}
