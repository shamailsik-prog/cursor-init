<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Local IDE: maximum agent autonomy (one-time on your machine)

Repo policy for agents lives under `.cursor/` (`cli.json`, `permissions.json`, `sandbox.json`). Cloud Agents already auto-run tools; `environment.json` sets `egressMode` to `allow_all` when team policy allows.

To remove most **desktop IDE** approval prompts, set **Settings → Agents → Approvals & Execution → Run Everything**. Optional: copy the same three JSON files to `~/.cursor/` so every repo on your machine inherits them. Team dashboard Run Mode / network locks override project files.

## Cloud / Legal OS agents: PR merge, approve, resolve (no permission prompts)

When the user or runbook asks to land work, do **not** stop to ask whether you may merge, approve, or resolve review threads.

- **Land code:** squash-merge onto `main` with plain `git` (never force-push `main`), `git push origin main`, then close the PR with a comment that names the landing SHA and first parent.
- **Approve:** `origin pr review <n> --approve -b "…"` when forge policy requires an approval before close (optional if already landed via git).
- **Resolve threads:** `origin pr thread list <n>` then `origin pr thread resolve <thread-id> <n>` for landing comments and addressed review feedback.
- **Superseded PRs:** close open PRs whose slices are already on `main`, with a short comment pointing at the landing SHA on `main`.
- **Create/update PRs:** use `ManagePullRequest`; set `backend_real`, `frontend_real`, and `transport_stub` truthfully and run `ci_gates/check_pr_phase_claims.py` before land.

Repo policy for tool approvals is also in `.cursor/permissions.json` (`autoRun.allow_instructions`).
