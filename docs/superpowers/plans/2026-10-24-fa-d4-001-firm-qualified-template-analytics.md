# FA-D4-001 Firm-Qualified Template Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Execution ruling (owner autonomy): native, by the builder of this branch, in this session.

**Goal:** `draft_template_analytics` rows are keyed and written per firm, so no firm's compose or template search can change another firm's row, and legacy shared rows are moved or reported.

**Architecture:** One id builder and one decision function in `platform/persistence/draftTemplateAnalytics.ts`; both repositories expose a single transactional writer `record(...)`; the D4 drafts route calls it; a one-off backfill (F13-003 pattern) moves legacy rows; the rules bind a read to the firm-qualified id.

**Tech Stack:** Next route handlers, Firestore (Admin SDK through `firestoreDbModular`), firebase rules, vitest under the Auth + Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-24-fa-d4-001-firm-qualified-template-analytics-design.md`

## Global Constraints

- Id: `template:${firmId}:${templateId}`; refuse an empty part or a part containing `:` or `/` (R1).
- F12 / F13 helpers (`getById`, `listAllRowsByFirm`, `asFirmScopedList`, `requireCallerFirmId`, `runTransaction` wrapper) are used, never edited (R3).
- Collection name stays `draft_template_analytics` (R10).
- Private emulators only: firestore 8097, auth 9097, hub 4091, logging 4093, websocket 8098; project `demo-fa-d4-001`; UI disabled.
- No `npm ci` / `npm install`; vitest with `--no-cache`.

## Review Focus

1. A row at the caller's own firm-qualified id stamped with another firm: refused, untouched (Task 1 e2e test 5; Task 2 unit).
2. Concurrent composes of one template by two firms: one row per firm, exact counts (Task 1 e2e test 3).
3. A legacy row with drafts from two firms: reported with ids only, never moved (Task 3).
4. A firm that composed after deploy and before the backfill: the backfill merges, counts summed (Task 3).
5. A backfill rerun after apply: nothing moved, nothing written except audit rows (Task 3).

## File Structure

| File | Responsibility |
|---|---|
| `platform/persistence/draftTemplateAnalytics.ts` (modify) | id builder/parser, legacy test, validator, `nextDraftTemplateAnalyticsRow`, errors |
| `platform/persistence/spineRepositories.ts` (modify) | repository type; memory implementation |
| `platform/persistence/firestoreSpineRepositories.ts` (modify) | Firestore implementation |
| `app/api/d4/drafts/route.ts` (modify) | compose and search call `record` |
| `platform/persistence/draftTemplateAnalyticsBackfill.ts` (create) | pure plan, dry-run text, apply + audit rows |
| `scripts/lib/draftTemplateAnalyticsBackfillAdmin.ts` (create) | Admin SDK loader and store |
| `scripts/lib/draftTemplateAnalyticsBackfillCli.ts` (create) | argv, logging, exit codes |
| `scripts/backfill-template-analytics.ts` (create), `package.json` (script) | operator entry |
| `firestore.rules` (this block only), `functions/test/g2.cross-firm.test.ts` (fixture) | R9 |

---

### Task 1: Firm-qualified id and transactional writer (Next stack)

**Files:**
- Modify: `platform/persistence/draftTemplateAnalytics.ts`, `platform/persistence/spineRepositories.ts:715-719,3240-3250`, `platform/persistence/firestoreSpineRepositories.ts:2332-2342`, `app/api/d4/drafts/route.ts:24-29,161-189,366-379`
- Test: `tests/fa-d4-001-template-analytics.e2e.firestore.test.ts` (written first, RED 5/5 on main), `tests/fa-d4-001-template-analytics.unit.test.ts`
- Update: `tests/persistence.repositories.test.ts:436-457`, `tests/persistence.route-wiring.test.ts:1701-1719`

**Interfaces (produces):**
- `draftTemplateAnalyticsId(firmId: string, templateId: string): string`
- `parseDraftTemplateAnalyticsId(id: string): { firmId: string; templateId: string } | null`
- `isLegacyDraftTemplateAnalyticsId(id: string): boolean` (true for `template:{T}` with no further `:` and no `/`)
- `readDraftTemplateAnalyticsRow(id: string, data: unknown): DraftTemplateAnalyticsRow | null`
- `type DraftTemplateAnalyticsChange = { kind: "compose" } | { kind: "search"; query: string }`
- `nextDraftTemplateAnalyticsRow(firmId, template: TemplateSummary, stored: unknown | null, change, opts?: { now?: number }): DraftTemplateAnalyticsRow` (throws `DraftTemplateAnalyticsRefusedError` with `reason: "foreign_firm" | "malformed"`)
- `class DraftTemplateAnalyticsIdError`, `class DraftTemplateAnalyticsRefusedError` (`code = "template_analytics_refused"`)
- Repository: `record(firmId, template, change, opts?) => Promise<DraftTemplateAnalyticsRow>`, `get(id, firmId)`, `listByFirm(firmId)`

- [x] **Step 1: Write the failing e2e** (5 tests: compose isolation, search isolation, concurrency 3+3, legacy ignored, foreign stamp refused). Run: `vt.sh tests/fa-d4-001-template-analytics.e2e.firestore.test.ts`. Observed on main: 5 failed (ledger).
- [ ] **Step 2: Write the unit test** (memory repository and pure functions): id literal `template:firm_a:writ_mandamus`; refusal of `""`, `"a:b"`, `"a/b"` in either part; validator null for legacy id, mismatched id, each wrong-typed field, negative or fractional count; decision: fresh row, compose +1, search +1 with query, foreign stamp throws `foreign_firm`, malformed throws `malformed`; memory `record` for two firms leaves two rows; memory `listByFirm` drops a legacy row.
- [ ] **Step 3: Run it; expect FAIL** (exports absent).
- [ ] **Step 4: Implement** the interfaces above; Firestore `record` = `runTransaction` reading `doc(db, COLL, id)`, `tx.set(ref, next)`; `get` = `getById` then the validator; `listByFirm` = `listAllRowsByFirm` + validator filter + `asFirmScopedList`. Route: compose `record(actor.firmId, {id,name,posture,category}, {kind:"compose"})`; search loop `record(refreshedActor.firmId, entry.template, {kind:"search", query}, {now})`.
- [ ] **Step 5: Update the two existing tests** to the new API (`record` instead of `upsert`; canonical id in the stub row).
- [ ] **Step 6: Run** unit + e2e + `tests/persistence.repositories.test.ts` + `tests/persistence.runtime-mode.test.ts` + `tests/persistence.route-wiring.test.ts` + `tests/api.drafts.test.ts`. Expected: all pass.
- [ ] **Step 7: Commit, gitleaks, push.**

### Task 2: Rules bind reads to the firm-qualified id

**Files:** Modify `firestore.rules:391`; fixture `functions/test/g2.cross-firm.test.ts` (`docIdFor`, `seedFor`). Test: `tests/fa-d4-001-template-analytics.rules.firestore.test.ts` (written first, RED 2/6 on main).

- [x] **Step 1: Write the failing rules test.** Observed on main: 2 failed (legacy get, mismatched get), 4 passed.
- [ ] **Step 2: Implement** `allow get: if sameFirm() && role() in ['partner', 'associate', 'clerk'] && id == 'template:' + resource.data.firmId + ':' + resource.data.templateId; allow list: if sameFirm() && role() in ['partner', 'associate', 'clerk']; allow write: if false;` (one line, no second `match /` on it).
- [ ] **Step 3: G-2 fixture**: `draft_template_analytics` seeded at `template:g2-rules-firm-a:g2_template` with `templateId: "g2_template"`.
- [ ] **Step 4: Run** the rules test (6/6), `tests/firestore.rules*.test.ts`, `tests/f32-ttl-*.test.ts`, and `npm run gate:g2`. Expected: pass.
- [ ] **Step 5: Commit, gitleaks, push.**

### Task 3: Legacy backfill

**Files:** Create the four backfill files and the `backfill:template-analytics` script. Test: `tests/fa-d4-001-template-analytics-backfill.e2e.firestore.test.ts`.

**Interfaces (produces):**
- `planTemplateAnalyticsBackfill(rows: BackfillRow[], draftFirmsByTemplate: Map<string, Set<string>>): TemplateAnalyticsBackfillPlan` with `moves: {from, to, firmId, templateId, snapshot}[]`, `canonical: string[]`, `unrecoverable: {path, firmIds}[]`, `malformed: string[]`
- `formatTemplateAnalyticsBackfillDryRun(plan): string` (prefix `[backfill-template-analytics]`)
- `mergeTemplateAnalyticsRows(target: DraftTemplateAnalyticsRow, legacy: DraftTemplateAnalyticsRow): DraftTemplateAnalyticsRow`
- `applyTemplateAnalyticsBackfill(store, plan, {runId, now}) => {moved, rejected, failed}`; store: `move(planned) => {status:"moved"|"merged"} | {status:"rejected", reason}`, `appendAudit(row)`
- `runTemplateAnalyticsBackfill(argv, deps) => Promise<0 | 1 | 2>`

- [ ] **Step 1: Write the failing test**: dry-run writes nothing and names each row; apply moves a clean legacy row (legacy gone, target equals legacy fields with the canonical id); merges into an existing target (composeCount 2+3 = 5, later `lastTemplateSearchQuery` kept); leaves an unrecoverable row (drafts from two firms) untouched and reports `{path, firmIds}` with no counts; leaves a malformed row; rerun plans no move; CLI exit 2 with unrecoverable, 0 without, 1 when the store throws; audit summary row counts.
- [ ] **Step 2: Run; expect FAIL** (module absent).
- [ ] **Step 3: Implement** per spec R8.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit, gitleaks, push.**

### Task 4: Verification and mutation

- [ ] Mutants (each run against the owning suite, then reverted): M1 id drops firm; M2 separator check removed; M3 firm check in `nextDraftTemplateAnalyticsRow` removed; M4 validator id check removed; M5 route search path back to a blind write; M6 Firestore `record` outside a transaction (get + set); M7 backfill deletes nothing (copy only); M8 unrecoverable detection off; M9 merge takes the target's count only; M10 rules get without the id check; M11 rules get without `sameFirm()`; M12 legacy filter off in `listByFirm`.
- [ ] Gates: root typecheck, `tsc -p tsconfig.tests.json`, eslint on touched files, D4 / F12 / F13 / rules suites, G-0, G-1, G-2, claim gate on the PR body.

## RED/GREEN ledger

| Test | main `3c8ccb9` | branch |
|---|---|---|
| e2e: B's row survives A's compose | FAIL (B's row gone; `template:T` stamped A) | pending |
| e2e: B's row survives A's search | FAIL (B's row gone) | pending |
| e2e: concurrent 3+3 composes, one row per firm, count 3 | FAIL (one shared row, `composeCount: 2`) | pending |
| e2e: legacy row never read or written | FAIL (legacy `composeCount` 7 to 8) | pending |
| e2e: foreign stamp at own id refused | FAIL (status 200) | pending |
| rules: control + cross-firm + writes + intern (4) | pass | pending |
| rules: legacy id not readable | FAIL (allowed) | pending |
| rules: mismatched id readable by neither | FAIL (allowed to firm B) | pending |
| backfill e2e | FAIL (module absent) | pending |
