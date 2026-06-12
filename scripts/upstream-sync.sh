#!/usr/bin/env bash
#
# upstream-sync.sh — READ-ONLY upstream/fork delta reporter.
#
# Prints (a) the pull-DOWN delta (upstream/staging since our alignment base) and
# (b) the push-BACK delta (what our fork has that upstream/staging does not).
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ NON-DESTRUCTIVE: this script only READS git history (log/show/diff/      │
# │ rev-parse/merge-base). It never checks out, merges, rebases, resets, or   │
# │ pushes. `git fetch` runs ONLY if you pass --fetch.                        │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Usage:
#   scripts/upstream-sync.sh            # report using already-fetched refs
#   scripts/upstream-sync.sh --fetch    # `git fetch upstream --prune` first, then report
#
# See docs/UPSTREAM_SYNC.md for how to act on this output.

set -euo pipefail

UPSTREAM_REF="${UPSTREAM_REF:-upstream/staging}"
FORK_REF="${FORK_REF:-origin/main}"
# Alignment base: the upstream commit our `align/upstream-staging` was founded on.
BASE_REF="${BASE_REF:-da85ccc}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
rule() { printf '%s\n' "------------------------------------------------------------------------"; }

if [[ "${1:-}" == "--fetch" ]]; then
  bold "Fetching ${UPSTREAM_REF%%/*} (prune)…"
  git fetch "${UPSTREAM_REF%%/*}" --prune
  echo
fi

# --- sanity: refs must resolve ------------------------------------------------
for ref in "$UPSTREAM_REF" "$FORK_REF" "$BASE_REF"; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "ERROR: ref '$ref' did not resolve. Run with --fetch, or set UPSTREAM_REF/FORK_REF/BASE_REF." >&2
    exit 1
  fi
done

# --- topology -----------------------------------------------------------------
rule; bold "Topology"; rule
MB="$(git merge-base "$FORK_REF" "$UPSTREAM_REF")"
printf 'upstream : %-16s (%s)\n' "$UPSTREAM_REF" "$(git rev-parse --short "$UPSTREAM_REF")"
printf 'fork     : %-16s (%s)\n' "$FORK_REF" "$(git rev-parse --short "$FORK_REF")"
printf 'base     : %-16s (%s)\n' "$BASE_REF" "$(git rev-parse --short "$BASE_REF")"
printf 'merge-base(fork,upstream) = %s\n' "$(git rev-parse --short "$MB")"
if git merge-base --is-ancestor "$BASE_REF" "$UPSTREAM_REF"; then
  echo "ok: $BASE_REF is an ancestor of $UPSTREAM_REF"
else
  echo "WARN: $BASE_REF is NOT an ancestor of $UPSTREAM_REF — alignment base may be stale."
fi
echo

# --- pull-DOWN delta ----------------------------------------------------------
rule; bold "Pull-DOWN candidates: ${BASE_REF}..${UPSTREAM_REF}"; rule
COUNT_DOWN="$(git rev-list --count "${BASE_REF}..${UPSTREAM_REF}")"
echo "(${COUNT_DOWN} commit(s) — classify each PULL / REVIEW / SKIP, see docs/UPSTREAM_SYNC.md Appendix A)"
git --no-pager log --oneline --stat=80 "${BASE_REF}..${UPSTREAM_REF}" || true
echo

# --- push-BACK delta ----------------------------------------------------------
rule; bold "Push-BACK candidates: ${UPSTREAM_REF}..${FORK_REF} (no merges)"; rule
COUNT_UP="$(git rev-list --count --no-merges "${UPSTREAM_REF}..${FORK_REF}")"
echo "(${COUNT_UP} non-merge commit(s) — classify CONTRIBUTE / FORK-ONLY, see docs/UPSTREAM_SYNC.md Appendix B)"
git --no-pager log --oneline --no-merges "${UPSTREAM_REF}..${FORK_REF}" || true
echo

# --- divergence guard (informational) ----------------------------------------
rule; bold "Fork divergence guard (must stay true)"; rule
if git ls-tree --name-only "$FORK_REF" -- src/services/storage.ts | grep -q .; then
  echo "WARN: $FORK_REF has src/services/storage.ts (upstream's file). Expected our storage/ directory."
else
  echo "ok: no src/services/storage.ts on $FORK_REF (we use the storage/ directory)."
fi
if git ls-tree --name-only "$FORK_REF" -- .github/workflows/azure-deploy.yml | grep -q .; then
  echo "ok: azure-deploy.yml present on $FORK_REF."
else
  echo "WARN: azure-deploy.yml missing on $FORK_REF — our active CI/CD!"
fi
echo "Reminder: keep Fly workflows 'on: workflow_dispatch' and never push Azure/secret files upstream."
