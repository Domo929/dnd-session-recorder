import { describe, expect, it } from 'vitest';
import { formatSearchTimestamp, getSourceTypeLabel } from '../campaignSearchHelpers';

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
});
