'use client';

import { useQuery } from '@tanstack/react-query';

export interface SpeakerCluster {
  id: string;
  clusterIdx: number;
  displayLabel: string;
  voiceSampleId: string | null;
  matchConfidence: string;
  matchedScore: number | null;
  snippetBlobPath: string | null;
  snippetAvailable: boolean;
  voiceLabel: string | null;
  playedByEmail: string | null;
  npcSuggestion: {
    id: string;
    suggestedName: string;
    confidence: string;
    reasoning: string;
    status: string;
  } | null;
}

export interface SpeakerTurn {
  speakerClusterId: string | null;
  startTime: number;
  text: string;
}

export interface SpeakerData {
  transcriptionMode: string;
  diarizationStatus: string;
  needsResummarize: boolean;
  clusters: SpeakerCluster[];
  turns: SpeakerTurn[];
  voiceOptions: { id: string; label: string }[];
  canTag: boolean;
}

/**
 * Loads the speaker-aware transcript payload. Returns `enabled: false`-style
 * empty data until the session id is known. Shared cache key so the transcript
 * view and the re-summarize banner stay in sync.
 */
export function useSpeakerData(sessionId: string) {
  return useQuery<SpeakerData>({
    queryKey: ['speakers', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/speakers`);
      if (!res.ok) throw new Error('Failed to load speaker transcript');
      return res.json();
    },
    enabled: !!sessionId,
  });
}

/** True when this session has a completed speaker-labeled transcript to show. */
export function hasSpeakerView(data: SpeakerData | undefined): boolean {
  return (
    !!data &&
    data.transcriptionMode === 'speaker_labeled' &&
    data.diarizationStatus === 'completed' &&
    data.clusters.length > 0
  );
}
