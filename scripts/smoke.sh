#!/usr/bin/env bash
# Local end-to-end smoke test against the production Docker image.
#
# Brings up the same image we ship to Azure (via docker-compose.yml +
# docker-compose.smoke.yml), waits for the health check, runs the single
# Playwright spec at tests/e2e/smoke.spec.ts, and tears the stack down.
#
# Designed to be re-runnable: each invocation uses fresh named volumes and
# `compose down -v` cleans them up on exit (success or failure).
#
# Usage:
#   npm run smoke
#   bash scripts/smoke.sh
#
# Env overrides:
#   SMOKE_BASE_URL      default http://localhost:3000
#   SMOKE_NO_TEARDOWN=1 keep the stack running after the test for debugging

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT=smoke-test
BASE_URL="${SMOKE_BASE_URL:-http://localhost:3000}"
HEALTH_TIMEOUT_SECS=180

compose() {
  docker compose -p "$PROJECT" \
    -f docker-compose.yml -f docker-compose.smoke.yml "$@"
}

teardown() {
  if [[ "${SMOKE_NO_TEARDOWN:-}" == "1" ]]; then
    echo "[smoke] SMOKE_NO_TEARDOWN=1 — leaving stack running."
    return
  fi
  echo "[smoke] tearing down stack…"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap teardown EXIT

echo "[smoke] ensuring Playwright chromium is installed…"
npx --no-install playwright install chromium >/dev/null 2>&1 || \
  npx playwright install chromium

echo "[smoke] building and starting Docker stack (project=$PROJECT)…"
compose up --build -d

echo "[smoke] waiting for $BASE_URL/api/health (timeout ${HEALTH_TIMEOUT_SECS}s)…"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
until curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; do
  if (( $(date +%s) > deadline )); then
    echo "[smoke] timed out waiting for /api/health. Container logs:"
    compose logs --tail=100 dnd-recorder || true
    exit 1
  fi
  sleep 2
done
echo "[smoke] app is healthy."

echo "[smoke] running Playwright spec…"
SMOKE_BASE_URL="$BASE_URL" npx playwright test tests/e2e/smoke.spec.ts
