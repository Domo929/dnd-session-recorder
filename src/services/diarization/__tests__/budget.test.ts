import { describe, expect, it } from 'vitest';

import { evaluateDispatch, type DispatchState } from '../budget';
import { getDispatchConfig, isDispatchConfigured, type DispatchConfig } from '../config';

const baseConfig: DispatchConfig = {
  maxDailyUsd: 5,
  maxConcurrent: 3,
  maxPerCampaign: 1,
  regions: ['centralus', 'westus2'],
  image: 'ghcr.io/x/diarization:latest',
  estimatedCostUsd: 0.3,
  callbackBaseUrl: 'https://app.example.com',
  sasTtlMs: 2 * 60 * 60 * 1000,
  subscriptionId: 'sub',
  resourceGroup: 'rg',
  gpuSku: 'T4',
};

const baseState: DispatchState = {
  running: 0,
  runningInCampaign: 0,
  dailySpendUsd: 0,
  bypassBudget: false,
};

describe('getDispatchConfig', () => {
  it('applies design defaults with an empty env', () => {
    const c = getDispatchConfig({} as NodeJS.ProcessEnv);
    expect(c.maxDailyUsd).toBe(5);
    expect(c.maxConcurrent).toBe(3);
    expect(c.maxPerCampaign).toBe(1);
    expect(c.regions).toEqual(['centralus', 'westus2', 'eastus2']);
    expect(c.sasTtlMs).toBe(2 * 60 * 60 * 1000);
    expect(c.image).toBeNull();
  });

  it('parses overrides and trims the region list', () => {
    const c = getDispatchConfig({
      DIARIZATION_MAX_DAILY_USD: '12',
      DIARIZATION_MAX_CONCURRENT: '5',
      DIARIZATION_MAX_PER_CAMPAIGN: '2',
      DIARIZATION_REGIONS: ' eastus2 , westus3 ',
      DIARIZATION_IMAGE: 'img',
      DIARIZATION_SAS_TTL_MINUTES: '30',
    } as unknown as NodeJS.ProcessEnv);
    expect(c.maxDailyUsd).toBe(12);
    expect(c.maxConcurrent).toBe(5);
    expect(c.maxPerCampaign).toBe(2);
    expect(c.regions).toEqual(['eastus2', 'westus3']);
    expect(c.sasTtlMs).toBe(30 * 60 * 1000);
  });

  it('falls back to defaults for invalid numbers', () => {
    const c = getDispatchConfig({ DIARIZATION_MAX_DAILY_USD: 'abc' } as unknown as NodeJS.ProcessEnv);
    expect(c.maxDailyUsd).toBe(5);
  });

  it('reports configured only when all required fields are present', () => {
    expect(isDispatchConfigured(baseConfig)).toBe(true);
    expect(isDispatchConfigured({ ...baseConfig, image: null })).toBe(false);
    expect(isDispatchConfigured({ ...baseConfig, callbackBaseUrl: null })).toBe(false);
    expect(isDispatchConfigured({ ...baseConfig, subscriptionId: null })).toBe(false);
    expect(isDispatchConfigured({ ...baseConfig, resourceGroup: null })).toBe(false);
  });
});

describe('evaluateDispatch', () => {
  it('allows a dispatch within all caps', () => {
    expect(evaluateDispatch(baseState, baseConfig)).toEqual({ allowed: true });
  });

  it('denies when the system concurrency cap is reached', () => {
    expect(evaluateDispatch({ ...baseState, running: 3 }, baseConfig)).toEqual({
      allowed: false,
      reason: 'system_concurrency',
    });
  });

  it('denies when the per-campaign cap is reached', () => {
    expect(evaluateDispatch({ ...baseState, runningInCampaign: 1 }, baseConfig)).toEqual({
      allowed: false,
      reason: 'campaign_concurrency',
    });
  });

  it('denies when the next job would exceed the daily budget', () => {
    expect(evaluateDispatch({ ...baseState, dailySpendUsd: 4.8 }, baseConfig)).toEqual({
      allowed: false,
      reason: 'budget',
    });
  });

  it('allows over-budget dispatch when bypassBudget is set', () => {
    expect(
      evaluateDispatch({ ...baseState, dailySpendUsd: 100, bypassBudget: true }, baseConfig),
    ).toEqual({ allowed: true });
  });

  it('bypassBudget never overrides concurrency caps', () => {
    expect(
      evaluateDispatch({ ...baseState, running: 3, bypassBudget: true }, baseConfig),
    ).toEqual({ allowed: false, reason: 'system_concurrency' });
  });
});
