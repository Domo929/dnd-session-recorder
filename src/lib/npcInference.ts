import { z } from 'zod';
import { formatSpeakerTranscript, type LabeledTurn } from './speakerSummary';

/**
 * NPC inference (design Section 5): after summarization, ask the model to infer
 * names for unidentified speaker clusters. Suggestions are never auto-applied —
 * the DM accepts/rejects/edits each one.
 */

export interface NpcInferencePromptArgs {
  /** Display labels of the unknown clusters, e.g. ["DM (Unknown #2)"]. */
  unknownLabels: string[];
  turns: LabeledTurn[];
}

export function buildNpcInferencePrompt({ unknownLabels, turns }: NpcInferencePromptArgs): string {
  const labelList = unknownLabels.map((l) => `- ${l}`).join('\n');
  return `You are analyzing a transcript of a D&D session to infer the names of unidentified NPC voices.

The following speaker labels are unidentified NPCs voiced by the DM:
${labelList}

For each unidentified label, infer the most likely in-world name based ONLY on the transcript (e.g. how other speakers address them, or how they introduce themselves). If there is no good evidence, omit that label.

Transcript:
${formatSpeakerTranscript(turns)}

Respond with ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "label": "<the exact unidentified label>",
  "suggestedName": "<inferred in-world name>",
  "confidence": "low" | "medium" | "high",
  "reasoning": "<one sentence citing transcript evidence, with timestamps>"
}`;
}

export interface NpcSuggestion {
  label: string;
  suggestedName: string;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

const suggestionSchema = z.object({
  label: z.string().min(1),
  suggestedName: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().min(1),
});

/** Strip an optional ```json fence wrapping. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Parse the model's JSON array of suggestions. Best-effort and fail-soft:
 * returns only well-formed entries whose `label` is one of `allowedLabels`,
 * de-duplicated by label. Returns [] on any parse failure.
 */
export function parseNpcSuggestions(text: string, allowedLabels: string[]): NpcSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const allowed = new Set(allowedLabels);
  const seen = new Set<string>();
  const out: NpcSuggestion[] = [];
  for (const item of parsed) {
    const result = suggestionSchema.safeParse(item);
    if (!result.success) continue;
    const s = result.data;
    if (!allowed.has(s.label) || seen.has(s.label)) continue;
    seen.add(s.label);
    out.push(s);
  }
  return out;
}
