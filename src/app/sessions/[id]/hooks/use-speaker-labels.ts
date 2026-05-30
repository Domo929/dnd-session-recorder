'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface SpeakerLabels {
  defaults: { speakerKey: string; name: string }[];
  turns: { turnIndex: number; name: string }[];
  canEdit: boolean;
}

export interface SpeakerLabelUpdate {
  defaults?: { speakerKey: string; name: string }[];
  turns?: { turnIndex: number; name: string }[];
}

/** Per-session relabel state (basic-mode defaults + per-turn overrides). */
export function useSpeakerLabels(sessionId: string) {
  return useQuery<SpeakerLabels>({
    queryKey: ['speaker-labels', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/speaker-labels`);
      if (!res.ok) throw new Error('Failed to load speaker labels');
      return res.json();
    },
    enabled: !!sessionId,
  });
}

/** Campaign-wide name registry for relabel autocomplete. */
export function useSpeakerRegistry(campaignId: string | undefined) {
  return useQuery<string[]>({
    queryKey: ['speaker-registry', campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/speaker-registry`);
      if (!res.ok) throw new Error('Failed to load speaker registry');
      const json = await res.json();
      return json.names as string[];
    },
    enabled: !!campaignId,
  });
}

/** Save defaults/overrides; refreshes labels, registry, and summary state. */
export function useUpdateSpeakerLabels(sessionId: string, campaignId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (update: SpeakerLabelUpdate) => {
      const res = await fetch(`/api/sessions/${sessionId}/speaker-labels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to save names');
      }
      return res.json() as Promise<SpeakerLabels>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['speaker-labels', sessionId], data);
      queryClient.invalidateQueries({ queryKey: ['speaker-registry', campaignId] });
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['summary', sessionId] });
    },
  });
}
