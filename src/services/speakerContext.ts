import { db } from '@/services/database';
import type { SessionClusterView } from '@/services/database';
import { groupTurns } from '@/lib/speakerTranscript';
import { buildSpeakerSummaryPrompt, type LabeledTurn } from '@/lib/speakerSummary';

/**
 * Assemble the speaker-aware view of a session's transcript: a display label per
 * cluster, a one-line roster entry per cluster (design Section 5), and the
 * turn-grouped, labeled transcript shared by the summary + NPC inference prompts.
 */
export interface SpeakerContext {
  clusters: SessionClusterView[];
  labelByClusterId: Map<string, string>;
  roster: string[];
  turns: LabeledTurn[];
  unknownLabels: string[];
  transcriptChars: number;
}

/** Build a human-readable roster line for one cluster. */
export function rosterLine(c: SessionClusterView): string {
  const label = c.displayLabel;
  if (!c.voiceSampleId) {
    // Unidentified NPC voice (no voice linked yet).
    return `${label} — unidentified NPC voice`;
  }
  if (/^DM\s*\(/i.test(label)) {
    // DM-voiced: narration vs. a named/recurring NPC.
    return /narration/i.test(label) ? label : `${label} — recurring NPC`;
  }
  return c.playedByEmail ? `${label} (PC, played by ${c.playedByEmail})` : `${label} (PC)`;
}

export async function buildSpeakerContext(sessionId: string): Promise<SpeakerContext> {
  const clusters = await db.getSessionClusters(sessionId);
  const transcriptions = await db.getTranscriptions(sessionId);

  const labelByClusterId = new Map(clusters.map((c) => [c.id, c.displayLabel]));

  const grouped = groupTurns(
    transcriptions.map((t) => ({
      speakerClusterId: t.speakerClusterId,
      startTime: t.startTime,
      text: t.text,
    })),
  );
  const turns: LabeledTurn[] = grouped.map((g) => ({
    label: (g.speakerClusterId && labelByClusterId.get(g.speakerClusterId)) || 'Unknown speaker',
    startSec: g.startTime,
    text: g.text,
  }));

  return {
    clusters,
    labelByClusterId,
    roster: clusters.map(rosterLine),
    turns,
    unknownLabels: clusters.filter((c) => !c.voiceSampleId).map((c) => c.displayLabel),
    transcriptChars: transcriptions.reduce((n, t) => n + t.text.length, 0),
  };
}

export { buildSpeakerSummaryPrompt };
