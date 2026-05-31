import { describe, expect, it } from 'vitest';
import {
  formatSearchTimestamp,
  getSafeSearchSnippetHtml,
  getSourceTypeLabel,
} from '../campaignSearchHelpers';

describe('CampaignSearchCard helpers', () => {
  it('formats transcript timestamps as H:MM:SS', () => {
    expect(formatSearchTimestamp(0)).toBe('0:00');
    expect(formatSearchTimestamp(62)).toBe('1:02');
    expect(formatSearchTimestamp(3723)).toBe('1:02:03');
  });

  it('labels DM TODO search results for display', () => {
    expect(getSourceTypeLabel('transcript')).toBe('transcript');
    expect(getSourceTypeLabel('summary')).toBe('summary');
    expect(getSourceTypeLabel('dm_todo')).toBe('DM TODO');
  });

  it('escapes search snippets while preserving mark highlights', () => {
    expect(
      getSafeSearchSnippetHtml('<img src=x onerror=alert(1)> <mark>dragon</mark> & treasure'),
    ).toBe('&lt;img src=x onerror=alert(1)&gt; <mark>dragon</mark> &amp; treasure');
  });
});
