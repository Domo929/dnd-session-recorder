/**
 * Next.js instrumentation hook. Runs once on server startup (Node runtime only).
 * Starts the in-app diarization dispatcher/cleanup loops when configured; the
 * runtime itself fails closed when the environment isn't set up for ACI.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startDiarizationRuntime } = await import('@/services/diarization/runtime');
  startDiarizationRuntime();
}
