export type CampaignSearchSourceType = 'transcript' | 'summary' | 'dm_todo';

export function formatSearchTimestamp(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function getSourceTypeLabel(sourceType: CampaignSearchSourceType) {
  return sourceType === 'dm_todo' ? 'DM TODO' : sourceType;
}

export function getSafeSearchSnippetHtml(snippet: string) {
  const startMarkToken = '%%SEARCH_MARK_START%%';
  const endMarkToken = '%%SEARCH_MARK_END%%';

  return snippet
    .replaceAll('<mark>', startMarkToken)
    .replaceAll('</mark>', endMarkToken)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll(startMarkToken, '<mark>')
    .replaceAll(endMarkToken, '</mark>');
}
