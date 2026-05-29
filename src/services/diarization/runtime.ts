import { logger } from '@/lib/logger';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { createAciClient } from './aci';
import { getDispatchConfig, isDispatchConfigured } from './config';
import { dispatchQueuedJobs, reconcileRunningJobs, type DispatcherDeps } from './dispatcher';

const DISPATCH_INTERVAL_MS = 30 * 1000;
const RECONCILE_INTERVAL_MS = 60 * 1000;

let started = false;
let timers: NodeJS.Timeout[] = [];

/** Run one async task, swallowing/logging errors so the interval never dies. */
function guarded(name: string, fn: () => Promise<void>): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) return; // skip overlapping ticks.
    inFlight = true;
    fn()
      .catch((err) => logger.error(`[diarization] ${name} tick failed`, err as Error))
      .finally(() => {
        inFlight = false;
      });
  };
}

/**
 * Start the in-app diarization dispatcher + cleanup loops. No-op (fail closed)
 * unless the dispatcher is fully configured for this environment and an ACI
 * client could be constructed. Safe to call more than once; only starts once.
 */
export function startDiarizationRuntime(): void {
  if (started) return;

  const config = getDispatchConfig();
  if (!isDispatchConfigured(config)) {
    logger.info('[diarization] runtime not started (dispatcher not configured)');
    return;
  }
  const aci = createAciClient(config);
  if (!aci) {
    logger.info('[diarization] runtime not started (ACI client unavailable)');
    return;
  }

  const deps: DispatcherDeps = {
    db,
    aci,
    storage: getStorageService(),
    config,
  };

  const dispatchTick = guarded('dispatch', () => dispatchQueuedJobs(deps));
  const reconcileTick = guarded('reconcile', () => reconcileRunningJobs(deps));

  timers = [
    setInterval(dispatchTick, DISPATCH_INTERVAL_MS),
    setInterval(reconcileTick, RECONCILE_INTERVAL_MS),
  ];
  // Don't keep the event loop alive solely for these timers.
  timers.forEach((t) => t.unref?.());
  started = true;
  logger.info('[diarization] runtime started', {
    dispatchIntervalMs: DISPATCH_INTERVAL_MS,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    regions: config.regions,
  });
}

/** Stop the loops (test/teardown helper). */
export function stopDiarizationRuntime(): void {
  timers.forEach((t) => clearInterval(t));
  timers = [];
  started = false;
}
