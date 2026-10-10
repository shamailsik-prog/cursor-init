# Legal OS autopilot

The build keeps moving without a live Claude Code session. GitHub
(`shamailsik-prog/cursor-init`) is the master copy. Cursor stays off GitHub: it does not
push here or open PRs here. Claude Code is the only builder.

## How it runs

1. **A merge starts the next phase.** Every push to `main` (merging a PR) runs
   `.github/workflows/legal-os-continue.yml`. Because `claude-code-action` does not accept the
   `push` event, that run only re-dispatches the workflow (`workflow_dispatch`, reason
   `merge to main (<sha>)`), and the build happens in the dispatched run. Claude Code (`anthropics/claude-code-action`,
   model `sonnet`) reads `CLAUDE.md`, the architecture set, `ERRATUM_SET_2_PROPOSED.md` and
   `docs/superpowers/plans|specs`. It picks the **one** next incomplete phase or slice in the build
   order, builds it with the Superpowers workflow, runs the suites and gates, and opens **one** PR
   from a `claude/autopilot-<phase>` branch.
2. **One builder at a time.** If any PR from a `claude/*` branch is open, the workflow does
   nothing. That covers both Claude Code sessions and earlier autopilot runs. Runs are serialized.
3. **You merge.** The autopilot never merges and never pushes to `main`. CI (Gate G-0 with
   G-1/G-2/G-4, security, the PR phase-claim gate) runs on its PR. Merging it starts the next
   phase.
4. **Idle watchdog.** `.github/workflows/legal-os-watchdog.yml` runs every 6 hours. It acts only
   when no `claude/*` PR is open **and** `main` has had no commit for 12 hours. Then it opens an
   issue titled **"Legal OS stalled — start next phase"**, or comments on it if it is already
   open, and dispatches the continue workflow.
5. **Opt out per merge.** Put `[autopilot skip]` in the merge commit message.

## What each PR must carry

Every PR has the truthful `backend_real` / `frontend_real` / `transport_stub` table and
"Not a COMPLETE / product-done claim." The PR phase-claim gate enforces this. The autopilot
does not touch Origin and does not revive the retired lattice / workflow-SLO ops chain.

## Required setup (once)

| What | Where |
| --- | --- |
| Secret `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) | GitHub → this repo → Settings → Secrets and variables → Actions → New repository secret |
| Claude GitHub App installed on this repo | https://github.com/apps/claude |

Without a secret, the continue workflow opens the issue **"Legal OS autopilot needs a Claude
secret"** and stops. The watchdog still raises its stall issue. Without the GitHub App, Claude
cannot authenticate to GitHub to push its branch and open its PR, so the build step fails.

## Cost control

- One slice per run, `--max-turns 200` by default (override on a manual run).
- No run while a `claude/*` PR is open.
- The watchdog runs at most every 6 hours.
