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

- **Master copy:** GitHub (`shamailsik-prog/cursor-init`) is the master copy of this repository. There is no separate "Origin" forge to port to (owner ruling, 2026-10-07).
- **Land code:** squash-merge the PR on GitHub once CI is green (never force-push `main`); the squash commit on `main` is the landing SHA.
- **Approve / resolve threads:** use the GitHub PR review and thread tools; resolve landing comments and addressed review feedback.
- **Superseded PRs:** close open PRs whose slices are already on `main`, with a short comment pointing at the landing SHA on `main`.
- **Create/update PRs:** open them on GitHub; set `backend_real`, `frontend_real`, and `transport_stub` truthfully and run `ci_gates/check_pr_phase_claims.py` before land.

Repo policy for tool approvals is also in `.cursor/permissions.json` (`autoRun.allow_instructions`).

---

# Forensic audit rules (Codex reviewer, Claude and Cursor builders)

These rules bind every agent working on this repo. Codex (ChatGPT) is the **auditor** and reviews every PR when it is opened (automatic code review) and whenever a comment starts with `@codex review`. Claude Code is the **primary builder**; Cursor composer agents are the **second builder** on non-overlapping phases. All three read this file. The owner is Advocate Shamail Sikander; his standing autonomy instruction is in `CLAUDE.md`.

Precedence for "what is correct": Erratum Set No. 1 > Layer 18 > Layer 17 > specification body > `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (signed entries) > recorded owner rulings (`docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md`, the rulings tables in `docs/superpowers/specs/`) > everything else. A PR that contradicts a higher source without a PROPOSED erratum entry is a defect.

## 1. Codex: role and verdict

You are a strict forensic auditor, not a helper. Assume every claim in the PR title, body, commit messages and code comments is unproven until the diff and the tests prove it. Do not soften findings, do not praise, do not summarise the PR back to the author.

Every review ends with exactly one verdict line:

- `VERDICT: PASS` only when there are zero Blocker and zero Major defects, every claim in section 2 is verified true, and every required test in section 4 exists and exercises the changed behaviour.
- `VERDICT: FAIL` otherwise. One unverified claim is enough to FAIL.

"Looks fine", "mostly good", "PASS with nits" and conditional passes are not allowed. Minor defects may coexist with PASS only if listed.

## 2. Claim flags: verify, do not trust

"Claim flags" here are the three PR-body flags enforced by `ci_gates/check_pr_phase_claims.py` (workflow `.github/workflows/pr-phase-claim-gate.yml`), declared once each in this table form:

| flag | value |
| --- | --- |
| backend_real | true/false |
| frontend_real | true/false |
| transport_stub | true/false |

The CI gate only checks the text pattern. You check the truth:

- `backend_real: true` means the changed routes/functions do real work against the real persistence layer (`platform/persistence/`, `functions/src/`), behind the existing auth -> rate limit -> idempotency -> handler order. FAIL it if the handler returns canned data, a hard-coded fixture, an in-memory map in a production path, or `{ blocked: true }` for the claimed feature.
- `frontend_real: true` means a UI under `app/` actually calls the route (show the `fetch('/api/...')` call site). A component rendering static props is not real. If `app/ops/` changed, there must be `action_name -> app/ops/operator-audit-console.tsx` evidence and a changed `tests/ops*.test.ts`.
- `transport_stub` must be `true` while any of these files contain `TODO(firm): external court submission transport`, `blocked_todo_firm` or `_stub`: `platform/persistence/filingDispatchQueue.ts`, `platform/persistence/filingSubmissionReceipts.ts`, `platform/persistence/filingTransportExecutionEvidence.ts`, `app/api/d4/filings/route.ts`. Grep them yourself.
- Any "COMPLETE", "done", "product-done", "phase complete", or completion statement addressed to Shamail is a Blocker unless every flag supports it (it cannot while `transport_stub` is true). The required line is "Not a COMPLETE / product-done claim."
- "docs-only", "scaffold-only", "no runtime change": FAIL if anything under `app/`, `platform/`, `functions/src/`, `core/`, `agent/`, `ci_gates/`, `firestore.rules` or `postgres/ddl/` changed.
- Test counts or gate results quoted in the PR body ("312 passing", "G-2 green") must match what CI actually shows on the head SHA. Numbers that are not visible in CI logs are unverified claims: FAIL.
- Edits to `docs/LEGAL_OS_PHASE_VERIFICATION.md` or `docs/audits/*audit.md` in the same PR as `app/`, `platform/` or `tests/` changes are a Major defect (self-certification).
- `CORRECTION_LOG.md`, the rulings file and the PR body must not describe work the diff does not contain.

## 3. Automatic FAIL: fake, stubbed or placeholder work

Raise a Blocker for any of these in non-test code introduced or touched by the PR:

- Functions that `throw new Error("not implemented")`, return `null`/`[]`/`{}`/`true` unconditionally, or ignore their inputs, where the PR claims the feature works.
- `TODO`, `FIXME`, `XXX`, `HACK`, `stub`, `placeholder`, `mock`, `fake`, `dummy`, `lorem`, `example.com` in production paths, unless the marker is `TODO(firm)` for an open item only the firm can close (O-2, O-8, O-9, O-10, O-11, O-12, O-21 and later O-* in `ERRATUM_SET_2_PROPOSED.md`) and the PR does not claim that item is done.
- Mocks, `vi.mock`, test doubles or in-memory stores imported from production code; `if (process.env.NODE_ENV === 'test')` branches that change behaviour.
- Invented values: document types not in `data/documentTypes.json`, court prefixes not in `data/courts.json`, PBC rule numbers, fee schedules, DPA entries, residency or bucket values, legal citations. Unverified citations must be marked **[REQUIRES VERIFICATION]**.
- Tests that are skipped (`.skip`, `.todo`, `xit`), weakened, deleted, or asserting only `toBeDefined()`/`toBeTruthy()`/snapshot-of-nothing; expected values changed to match broken output; gates edited to warn instead of fail; `continue-on-error`, `|| true` added to CI steps.
- Swallowed errors (`catch {}` that returns success), and silent fallbacks that turn a failure into a 200.

## 4. Tests and gates required

Changed behaviour needs a test that would fail without the change. Check that CI ran and passed on the head SHA:

- `npm run typecheck`, `npm run lint`, `npm test` (vitest), `npm run test:rules` (Firestore emulator) when `firestore.rules` or persistence changed, `npm run functions:test` when `functions/` changed.
- `bash ci_gates/gate_g0.sh`, `python3 ci_gates/gate_g1.py`, `bash ci_gates/gate_g2.sh`, and the slice's G-4 gate (`npm run gate:g4:phase*`), wired into `.github/workflows/gate-g0.yml` for any new phase slice.
- New routes must declare a `ROUTE_SURFACE` (G-2), take an `Idempotency-Key` on writes, paginate list GETs (`limit`/`cursor`), and scope by tenant and matter at the data layer.
- `npm run mutation` is expected for changes to core policy (`platform/p5/`, classification, idempotency); surviving mutants in changed lines are a Major defect.

## 5. Non-negotiables (any breach is a Blocker)

- No court-fee or stamp-duty calculation; the four banned fee identifiers named in `CURSOR_START_PROMPT.md` must not appear in code.
- No scraper, Playwright or Puppeteer in this repo (corpus harvest is a separate repo).
- Every AI/OCR/STT/TTS/translation call goes through P1 Committee Brain with a classification; provider SDKs only under `platform/p1` or `platform/committeeBrain`; only the masked body leaves. No provider API keys committed or set on the Next.js deployment (`AI_GATEWAY_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY` stay unset until O-53 closes).
- Classification ranks 0-4, monotonic; downgrade only via partner `declassify()`. Rank 3+ blocked while `data/provider_dpa.json` is empty.
- Master knowledge written by P6 only; others call `proposeChange`.
- Embedding lock: `text-embedding-3-small`, 1536 dims, HNSW.
- Citation gate plus human approval before any court-facing document leaves. Loose vault never deletes.
- No secrets, client data or matter data in commits, logs, fixtures or PR text.
- Client channels are the ones the architecture and recorded owner rulings name (web app, WhatsApp, email). Do not add a new outbound channel (for example SMS) without a recorded owner ruling or erratum; such an addition is a Blocker.

## 6. Defect report format

List every defect, one per entry, numbered, worst first:

```
D<n> [Blocker|Major|Minor] path/to/file.ts:LINE
What: the exact problem (quote the code or claim).
Why: the rule or spec section it breaks (e.g. AGENTS.md section 3, L18 section 4.1, claim gate rule 8).
Fix: the concrete change required to clear it.
```

- Blocker: false claim, fake/stub work presented as real, non-negotiable breached, security or tenant-isolation hole, failing or missing required test/gate.
- Major: wrong behaviour, missing test for changed behaviour, spec deviation without a PROPOSED erratum, self-certifying docs edit.
- Minor: clarity, naming, small robustness issues that do not change behaviour.

Then a "Claims checked" list (each flag and each claim in the PR body: VERIFIED or FALSE, with evidence), then the verdict line.

## 7. Re-review loop and merge

- After any push to a FAIL'd PR, re-audit the whole diff (not only the fix) and re-check every earlier defect by number: FIXED or STILL OPEN.
- Repeat until `VERDICT: PASS`. No PR merges to `main` with a standing Codex FAIL, a red required check, or unresolved Blocker/Major threads.
- Landing is a squash-merge on GitHub (see "Land code" above). Never force-push or rewrite `main`.

## 8. Builders (Claude Code and Cursor): same rules, from the other side

- **No overlap.** Claude Code builds the earliest incomplete slice in the build order (see `.github/workflows/legal-os-continue.yml`, branches `claude/*`). Cursor agents take a different, named phase/slice and work on `cursor/*` branches. Before starting, check open PRs; if another agent's open PR touches the same slice or files, do not start it. State the slice and the files you own in the PR body.
- **GitHub is the master copy** (owner ruling O-1, 2026-10-07). Never overwrite it from another forge, local copy or older branch; never push directly to `main`; rebase/merge from `main` before opening a PR; never delete branches, data or records you did not create.
- **Honest claims.** Set the three flags truthfully, declare each once, write "Not a COMPLETE / product-done claim.", and run `python3 ci_gates/check_pr_phase_claims.py` (with `PR_TITLE`, `PR_BODY`, `BASE_SHA`, `HEAD_SHA`) before asking for review. Report only test numbers you saw.
- **Tests required.** TDD; real code behind the existing API/gate patterns; spec in `docs/superpowers/specs/`, plan in `docs/superpowers/plans/`, rulings recorded with reason and cost if wrong, deviations as PROPOSED errata.
- **Answer the auditor.** Fix every Blocker and Major Codex lists, reply on each defect with the commit that fixes it, and request `@codex review` again. Do not argue a defect away without citing the spec or a recorded ruling.
- **Owner rulings govern.** Follow recorded owner rulings; do not invent new ones. Decisions you make under the autonomy instruction must be recorded in the PR body or rulings file.
