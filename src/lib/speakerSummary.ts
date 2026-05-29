import { formatTimestamp } from './speakerTranscript';

/**
 * Speaker-aware summary prompt builder (design Section 5). Produces a prompt for
 * the existing `generateAiText(prompt, 'summary')` — no new summary service.
 */

export interface LabeledTurn {
  label: string;
  startSec: number;
  text: string;
}

/** One transcript line: `[mm:ss] Label: "text"`. */
export function formatSpeakerTranscript(turns: LabeledTurn[]): string {
  return turns
    .map((t) => `[${formatTimestamp(t.startSec)}] ${t.label}: "${t.text}"`)
    .join('\n');
}

export interface SpeakerSummaryPromptArgs {
  /** Pre-formatted roster lines, e.g. "Thorin (PC, played by alice@example.com)". */
  roster: string[];
  turns: LabeledTurn[];
  campaignSystemPrompt?: string | null;
}

export function buildSpeakerSummaryPrompt({
  roster,
  turns,
  campaignSystemPrompt,
}: SpeakerSummaryPromptArgs): string {
  const rosterBlock = roster.length
    ? roster.map((r) => `- ${r}`).join('\n')
    : '- (no identified speakers)';

  let prompt = `You are summarizing a D&D session.

Speakers in this session:
${rosterBlock}`;

  if (campaignSystemPrompt && campaignSystemPrompt.trim()) {
    prompt += `\n\nCampaign Context:\n${campaignSystemPrompt.trim()}`;
  }

  prompt += `

Transcript:
${formatSpeakerTranscript(turns)}

Produce a summary structured as:
1. What happened (chronological)
2. Key NPCs encountered (names where known, "an unidentified NPC voice" otherwise)
3. PC actions & decisions
4. Loose threads / open questions`;

  return prompt;
}
