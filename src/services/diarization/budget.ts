import type { DispatchConfig } from './config';

export type DispatchDenialReason =
  | 'system_concurrency'
  | 'campaign_concurrency'
  | 'budget';

export interface DispatchDecision {
  allowed: boolean;
  reason?: DispatchDenialReason;
}

export interface DispatchState {
  /** Running jobs system-wide. */
  running: number;
  /** Running jobs for the candidate job's campaign. */
  runningInCampaign: number;
  /** Sum of estimated USD already spent/committed today. */
  dailySpendUsd: number;
  /** Owner pressed "Override" for this session's budget cap. */
  bypassBudget: boolean;
}

/**
 * Decide whether one more diarization container may be launched. Concurrency
 * caps always apply (a budget override never lets us exceed them). The daily
 * budget cap fails closed and is the only check the per-session override can
 * waive. Adding `estimatedCostUsd` before comparing keeps us from stepping over
 * the cap with the job we're about to start.
 */
export function evaluateDispatch(state: DispatchState, config: DispatchConfig): DispatchDecision {
  if (state.running >= config.maxConcurrent) {
    return { allowed: false, reason: 'system_concurrency' };
  }
  if (state.runningInCampaign >= config.maxPerCampaign) {
    return { allowed: false, reason: 'campaign_concurrency' };
  }
  if (!state.bypassBudget && state.dailySpendUsd + config.estimatedCostUsd > config.maxDailyUsd) {
    return { allowed: false, reason: 'budget' };
  }
  return { allowed: true };
}
