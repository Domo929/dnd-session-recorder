# Upstream Sync Playbook

How to **pull changes down** from the upstream project and **push generic changes back** up,
without breaking this fork's Azure-vs-Fly divergence or leaking fork-specific infra upstream.

This is a living, command-oriented runbook. Re-run the delta commands (or
`scripts/upstream-sync.sh`) every time — the SHAs below are a snapshot, the
*process* is what's durable.

---

## 0. Topology you must understand first

| Remote / ref | Meaning |
| --- | --- |
| `origin` = `github.com/Domo929/dnd-session-recorder` | **our fork** |
| `upstream` = `github.com/kbrakke/dnd-session-recorder` | the project we forked |
| `upstream/staging` | upstream's **active dev branch** (most work lands here, not `main`) |
| `origin/main` | our integration branch |
| `align/upstream-staging` | branch that **re-founded on `upstream/staging` + re-applied fork keeps** |
| `da85ccc` | the **merge-base**: the upstream commit our alignment was founded on |

Verify the topology any time:

```bash
git fetch upstream --prune
git merge-base origin/main upstream/staging          # -> should be da85ccc
git merge-base --is-ancestor da85ccc upstream/staging && echo "da85ccc is an ancestor of staging"
```

### The fork's two big divergences (never lose these)

1. **Deploy target = Azure, not Fly.io.**
   - **Active CI/CD:** `.github/workflows/azure-deploy.yml` (`on: push, pull_request`) builds the
     image to GHCR and dispatches to the private `Domo929/dnd-recorder-deploy` repo.
     `.github/workflows/diarization-image.yml` is also active (GPU diarization image).
   - **Inherited Fly workflows are kept on disk but DISABLED** (`on: workflow_dispatch` only) purely
     for upstream-PR parity: `production.yml`, `staging.yml`, `fly-review.yml`, `post-merge.yml`,
     `pull-request.yml` (and `post-deploy-tests.yml` is `workflow_dispatch`/`workflow_call`).
     Upstream's copies are `push`/`pull_request`-triggered. **Never let an upstream pull flip our
     triggers back on, and never push our disabled triggers upstream.**
2. **Fork-only features** not (fully) upstream: multi-provider AI (Gemini + local whisper.cpp),
   campaign sharing (members/invites/email), Prometheus metrics + `/api/metrics`, speaker
   labels/training/diarization (GPU container), **direct-to-Azure-blob uploads**
   (`src/services/storage/` — a *directory*), NPC/term dictionary, resumable transcription, a batch
   of security fixes (IDOR/XSS), and in-progress campaign RAG chat.

> ⚠️ **Storage is a structural fork point.** Upstream stores audio in a single file
> `src/services/storage.ts` (**S3/Tigris, server-side upload**). We store it in a *directory*
> `src/services/storage/` (**Azure Blob + Azurite + local, direct-to-blob SAS**). A file-vs-directory
> path clash means git **cannot auto-merge** anything touching storage. Treat every upstream storage
> change as REVIEW, never a clean pull.

---

## 1. Pulling upstream → fork

### 1.1 Fetch and inspect the delta

```bash
git fetch upstream --prune

# Commits on staging since our alignment base (the pull-DOWN candidate list):
git --no-pager log --oneline da85ccc..upstream/staging

# Inspect any candidate before deciding:
git --no-pager show --stat <sha>          # footprint
git --no-pager show <sha> -- <path>       # exact hunks
git --no-pager diff da85ccc..upstream/staging -- <path>   # cumulative drift in one file
```

Classify every commit **PULL / REVIEW / SKIP** (see Appendix A for the current snapshot). Rules of thumb:

- **PULL** — generic + low conflict: security audit fixes, dep/vuln bumps, FK indexes, isolated bug
  fixes, new standalone helper files that don't exist here.
- **REVIEW** — valuable but collides with fork work: anything touching `storage`, the processing
  pipeline, `src/lib/ai.ts`, `database.ts`, `middleware.ts`, or a major dep bump (AI SDK).
- **SKIP** — fork-irrelevant: edits confined to the **disabled Fly workflows**, or wholesale
  rewrites of our diverged `LESSONS.md` / `*/CLAUDE.md`.

### 1.2 Recommended integration path

Given the `align/upstream-staging` pattern, prefer **selective cherry-pick onto a fresh topic
branch**, not a blind merge:

```bash
# Topic branch off our integration branch (NOT a checkout of staging):
git switch -c sync/staging-<yyyymmdd> origin/main

# Pull individual, clean commits:
git cherry-pick <sha>            # e.g. the FK-index / session-status commit

# For partial commits (take some hunks, drop fork-colliding ones):
git cherry-pick -n <sha>         # stage without committing
git restore --staged <fork-specific-path> && git checkout -- <fork-specific-path>
git commit
```

Decision guide:

- **Cherry-pick** (default) — for the handful of PULL/partial-REVIEW commits. Keeps history legible
  and keeps fork-specific files out.
- **Merge `upstream/staging`** — only when the delta is overwhelmingly generic and small. Expect a
  storage file/dir conflict; resolve by **keeping our `src/services/storage/` directory**.
- **Re-found** (the `align/upstream-staging` move) — only for a *major* upstream realignment. Branch
  off `upstream/staging`, then replay the fork keeps (Azure workflows, storage dir, multi-provider
  AI, sharing, metrics, speaker labels). High effort; reserve for big drift.

For schema/index changes, **don't copy upstream's migration SQL verbatim** (timestamp collisions +
Prisma drift). Instead add the same `@@index(...)` to our `prisma/schema.prisma` and generate a
fork-native migration:

```bash
# add @@index lines to schema.prisma, then:
npx prisma migrate dev --name add_fk_indexes
```

For dependency/audit commits, **do not apply upstream's `package-lock.json`** (our tree has Azure
SDK, Gemini, onnx, prom-client, nodemailer, etc.). Re-derive on our tree:

```bash
# adopt the security `overrides` block from package.json, then:
npm audit fix
npm audit                      # target: 0 vulns
```

### 1.3 Keep the Azure-vs-Fly divergence intact — files to NEVER overwrite

When integrating, **discard upstream's version of these** (keep ours):

```
.github/workflows/azure-deploy.yml          # ours only — upstream has no equivalent
.github/workflows/diarization-image.yml     # ours only
.github/workflows/production.yml            # keep our `on: workflow_dispatch`
.github/workflows/staging.yml               # keep our `on: workflow_dispatch`
.github/workflows/fly-review.yml            # keep our `on: workflow_dispatch`
.github/workflows/post-merge.yml            # keep our `on: workflow_dispatch`
.github/workflows/pull-request.yml          # keep our `on: workflow_dispatch`
.github/workflows/post-deploy-tests.yml     # keep our dispatch/workflow_call triggers
fly.toml / fly.staging.toml / fly.review.toml   # not our deploy target
src/services/storage/**                     # our Azure dir — never replace with storage.ts
LESSONS.md, CLAUDE.md, */CLAUDE.md          # fork-diverged docs; merge by hand if at all
```

Quick guard before committing a sync:

```bash
# Make sure no Fly workflow got re-enabled and no storage.ts crept in:
grep -RnE "on:\s*$|push:|pull_request:" .github/workflows/{production,staging,fly-review,post-merge,pull-request}.yml
git ls-files src/services/storage.ts        # MUST print nothing
git ls-files .github/workflows/azure-deploy.yml   # MUST still exist
```

### 1.4 Verify — the local CI gate

Run the full gate before opening a PR into `origin/main`. It must pass clean:

```bash
npx prisma generate && npm run lint && npm run typecheck && npm test && npm run build
```

(`npm test` = `vitest run`, `typecheck` = `tsc --noEmit`. Note `tsc` type-checks test files too.)
Then do the usual local smoke (`npm run dev`) for anything touching the pipeline or storage.

---

## 2. Opening PRs fork → upstream

**Target branch is `upstream/staging`, NOT `main`.** Upstream develops on staging; PRs to main get
ignored/rebased.

### 2.1 Build a clean topic branch with ONLY the generic change

Always branch off **`upstream/staging`** (so the PR diff is minimal and rebases cleanly), then bring
over *only* the generic file(s) — never a fork-specific file:

```bash
git fetch upstream --prune
git switch -c fix/<topic> upstream/staging       # base on staging, not origin/main

# Bring the generic change across from our work. Options:
git checkout origin/main -- <generic/path/only>  # take specific files from our branch
#   ...or cherry-pick a commit then strip fork bits:
git cherry-pick -n <our-sha>
git restore --staged <azure-or-fork-path> && git checkout -- <azure-or-fork-path>

# Re-target onto upstream's structure if it differs (e.g. our storage/ dir vs their storage.ts):
#   port the LOGIC into upstream's file rather than copying ours.

git commit -m "fix(<area>): <generic description>"
```

Verify the diff contains nothing fork-specific **before** pushing (see 2.3).

### 2.2 Branch naming + creating the PR

- **Branch names:** conventional-commit style, scoped, no fork/infra words:
  `fix/sanitize-dm-todo-markdown`, `fix/audio-mime-and-duration-probe`, `feat/app-wide-theming`.
  (Do **not** name branches after Azure, GHCR, blob, metrics, etc.)
- **Prerequisite:** `gh pr create --repo kbrakke/...` needs a head branch on a remote you can push
  to. You **cannot push to `upstream`** (not a maintainer), so push the topic branch to **your own
  fork of upstream** (here `origin`) and open the PR cross-repo:

```bash
git push origin fix/<topic>

gh pr create \
  --repo kbrakke/dnd-session-recorder \
  --base staging \
  --head Domo929:fix/<topic> \
  --title "fix(<area>): <generic description>" \
  --body  "<what/why, link to the upstream issue if any>"
```

> If `--head Domo929:branch` is rejected, confirm `origin` actually points at *your* fork of
> upstream (`gh repo view Domo929/dnd-session-recorder`) and that the branch was pushed.

### 2.3 Checklist — what must NEVER leak upstream

Before `gh pr create`, run:

```bash
git --no-pager diff --stat upstream/staging...HEAD     # review every file in the PR
```

The diff must contain **none** of:

- [ ] `.github/workflows/azure-deploy.yml`, `diarization-image.yml`, or any Azure/GHCR/dispatch step
- [ ] Re-enabled or re-disabled Fly workflow triggers (leave upstream's workflows untouched)
- [ ] `src/services/storage/**` (our Azure dir) or Azure SDK usage — port logic into their
      `storage.ts` instead
- [ ] Secrets / infra names: `AZURE_*`, `BUCKET_NAME`, `*_CONNECTION_STRING`, GHCR image names,
      `dnd-recorder-deploy`, `HUGGINGFACE_TOKEN`, ACI/container config, SMTP creds
- [ ] Prometheus/`/api/metrics`, multi-provider AI config, campaign-sharing email infra — unless the
      *whole* feature is being proposed and the maintainer has agreed
- [ ] Edits to our diverged `LESSONS.md` / `CLAUDE.md`

Each PR should be **one logical, generic change** with a test. Smaller = more likely to be merged.

---

## Appendix A — Pull-DOWN candidates (`da85ccc..upstream/staging`, snapshot)

10 commits, newest first. Verify live with `git --no-pager log --oneline da85ccc..upstream/staging`.

| # | SHA | Subject | Class | Why / conflict notes |
| --- | --- | --- | --- | --- |
| 10 | `523c0b5` | update workflow to latest | **SKIP** | Only bumps GitHub Action versions in the **disabled Fly workflows** + heavily rewrites our diverged `LESSONS.md`/`*/CLAUDE.md`. Our active CI is `azure-deploy.yml` (untouched upstream). Optionally hand-port the action bumps (`checkout@v6`, `setup-node@v6`, …) into `azure-deploy.yml`. |
| 9 | `55da404` | more audit | **PULL (adapt)** | Refines npm `overrides` (`cookie ^0.7.0`). Security-positive. Re-derive on our lockfile; don't copy theirs. |
| 8 | `806fa8a` | update packages to 0 vulns | **REVIEW** | Safe `overrides` (next/postcss, next-auth, dockerode, cookie) bundled with **breaking AI SDK majors** (`ai ^5→^6`, `@ai-sdk/openai ^2→^3`) that risk our multi-provider `src/lib/ai.ts`. Take the overrides; validate AI majors separately. |
| 7 | `1125d19` | add missing files | **PULL** ✅ | Cleanest pull. FK-index migration (`gaming_sessions.user_id/campaign_id`, `transcriptions.session_id`, `uploads.user_id` — these are **largely absent in our schema**) + new `src/lib/session-status.ts` (absent here). Apply via our own `@@index` + `prisma migrate dev` to avoid drift. |
| 6 | `a028770` | security audit, improve efficiency | **REVIEW** | Generic wins to cherry-pick: **register account-enumeration fix**, **health info-disclosure fix**, FK `@@index`. But the rate-limiter XFF fix is **Fly-specific** (`fly-client-ip` header — adapt to Azure Front Door), it edits `fly.toml` (skip), and the efficiency refactor overlaps files we diverged on (`database.ts`, `ai.ts`, `use-session-data.ts`, `audioProcessing.ts`). |
| 5 | `5a65441` | npm audit fix | **PULL (adapt)** | Pure lockfile audit fix. Re-run `npm audit fix` on our tree; don't apply their lock. |
| 4 | `ff96047` | more updates to staging tests | **SKIP/REVIEW** | Edits **disabled Fly workflows** + deletes a large `tests/post-deploy/**` Playwright suite + reworks staging tests (some hardcode Fly staging URLs). Don't overwrite our dispatch triggers; selectively adopt test ideas. |
| 3 | `4ff5981` | update staging tests | **REVIEW** | Staging Playwright rework + `middleware.ts` + a migration. **`middleware.ts` overlaps our `/api/metrics` whitelist** — review carefully. Mostly staging-test infra. |
| 2 | `661a982` | update tests and security fixes | **REVIEW (low value)** | Big refactor: new `route-utils.ts` (`requireSessionOwner` = simple `userId` check) + `formatting.ts`; deletes `database.d.ts` & `fileCleanup.ts`; edits `storage.ts` (file we lack). **Its security fix is already in our fork — and better:** our `requireSessionAccess` is **membership-based** (supports campaign sharing). Heavy structural conflict; skip the refactor. |
| 1 | `bae82d8` | migrate to bucket storage and robust pipeline for uploads | **REVIEW (high conflict)** | Two halves both clash: (1) **S3/Tigris server-side `storage.ts` (FILE)** vs our **Azure direct-to-blob `storage/` (DIR)** — file/dir structural conflict, ours is more advanced; (2) pipeline queue/worker vs our resumable-transcription approach. Do **not** pull; harvest the `backoff.ts`/`errors.ts` *ideas* only. |

**Pull order recommendation:** `1125d19` first (clean) → cherry-pick the generic security hunks of
`a028770` (register enumeration, health disclosure) → adopt `806fa8a`/`55da404` `overrides` + run our
own `npm audit fix` (`5a65441`). **Skip** `523c0b5`/`ff96047` workflow churn and **don't merge**
`bae82d8`/`661a982` (superseded by our Azure storage + membership authz).

---

## Appendix B — Push-BACK candidates (`upstream/staging..origin/main`)

Our fork is **49 commits ahead** (42 non-merge). Verify with
`git --no-pager log --oneline --no-merges upstream/staging..origin/main`.

### FORK-ONLY — do **not** contribute

| Group | Commits | Why fork-only |
| --- | --- | --- |
| Alignment / lockfile plumbing | `3d15bfc`, `36ef4f3` | re-founding mechanics, no upstream value |
| Azure vs Fly CI | `dc88d7e` (Azure deploy), `162955e` (disable Fly) | our infra; would break upstream |
| Direct-to-Azure-blob uploads | `891fd25` + `src/services/storage/**` | Azure SAS architecture; conflicts with upstream `storage.ts` |
| Prometheus metrics + `/api/metrics` | `dfd6f5b`, `642c72a` | fork observability stack (Azure/Grafana-oriented) |
| GPU diarization dispatcher + image | `1576776`, `2e5c90a`, `diarization-image.yml` | private container, `HUGGINGFACE_TOKEN`, ACI |
| Multi-provider AI (Gemini + whisper.cpp) | `6e4fe0a` | large, config/secret-heavy; only as a designed proposal |
| Campaign sharing (members/invites/email) | `1400102` | large feature w/ SMTP infra; only as a designed proposal |

### CONTRIBUTE — generic, upstream-appropriate (candidate PRs)

| # | Scope (commits / area) | Suggested branch | Why upstream-appropriate |
| --- | --- | --- | --- |
| 1 ⭐ | **Markdown XSS sanitizer.** From `69119bd`, take **only** `renderMarkdownToSafeHtml()` (marked + DOMPurify / isomorphic-dompurify) + `dm-todo-panel` wiring + the sanitizer unit test. Exclude the blob-aware delete (Azure) and the membership-authz hunks. | `fix/sanitize-dm-todo-markdown` | Upstream renders DM-TODO markdown via `dangerouslySetInnerHTML` with **no sanitizer** (marked dropped `sanitize` in v5+) → stored XSS from transcript/shared content. Small, clearly generic, security-relevant. |
| 2 | **Audio MIME + duration robustness.** `24e0024` (accept codec-qualified MIME like `audio/webm;codecs=opus`) + `f444b61` (probe duration by decoding when the container reports none). Port the logic into upstream's validation/`audioProcessing`. | `fix/audio-mime-and-duration-probe` | Generic media-handling correctness; both ship with tests. |
| 3 | **Process-trigger error handling.** From `69119bd` (+ `dc6c47b`, `993bccf`): mark a session `error` when the async transcription/summary trigger returns non-OK, instead of leaving it stuck `transcribing`/`summarizing`. | `fix/process-trigger-error-handling` | Upstream's fetch-based async trigger has the same stuck-state bug. Re-verify against upstream's post-`bae82d8` pipeline shape. |
| 4 | **Small UI correctness.** `d23620a` (duration as seconds), `4540e7a` (camelCase campaign date fields), `ba11504` (ellipsis placeholder). | `fix/ui-correctness-small` | Trivial, generic, no fork coupling. Confirm each still maps to upstream components. |
| 5 | **App-wide persistent theming.** `3b320b1` (theme-provider + persistence). | `feat/app-wide-theming` | Generic UX; medium size. Optional — gauge maintainer appetite first. |
| 6 | *(larger, discuss first)* **Resumable, rate-limited transcription** `5c3451c`; **NPC/term dictionary** `76b0e85`. | `feat/resumable-transcription`, `feat/campaign-vocabulary` | Generally useful but coupled to our pipeline/schema; needs rework onto upstream's queue/worker. Propose design before coding. |

**Contribute order recommendation:** PR #1 (markdown XSS sanitizer) first — highest value, clearly
generic, security-relevant, smallest clean isolation. Then #2 (audio MIME/duration) and #4 (small UI
fixes).

---

## Quick reference

```bash
# See both deltas at a glance (read-only):
scripts/upstream-sync.sh

# Pull-down candidate list:
git --no-pager log --oneline da85ccc..upstream/staging
# Push-back candidate list:
git --no-pager log --oneline --no-merges upstream/staging..origin/main

# Local CI gate (must pass before any PR):
npx prisma generate && npm run lint && npm run typecheck && npm test && npm run build
```
