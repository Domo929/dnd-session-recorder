export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export interface CitationInput {
  sessionTitle: string;
  sourceType: string; // transcript | summary | dm_todo
  speakerLabels: string[];
  startTime: number | null;
}

export function formatCitation(c: CitationInput): string {
  if (c.sourceType !== 'transcript') {
    const label = c.sourceType === 'dm_todo' ? 'DM TODO' : 'summary';
    return `[Session "${c.sessionTitle}" — ${label}]`;
  }
  const ts = c.startTime != null ? ` @ ${formatTimestamp(c.startTime)}` : '';
  let who = '';
  if (c.speakerLabels.length === 1) who = `, ${c.speakerLabels[0]}`;
  else if (c.speakerLabels.length > 1) who = `, speakers: ${c.speakerLabels.join(', ')}`;
  return `[Session "${c.sessionTitle}"${ts}${who}]`;
}
