# Legal OS Phase Auditor Findings: PR #38-#47 (Batch D)

Date: 2026-09-20  
Auditor stance: independent forensic verification, no completeness assumptions.

## Overall verdict

**PARTIAL (major overall; blockers present on filing-linked items).**

### Primary blockers

1. **Frontend coverage is incomplete for multiple claimed-complete APIs** (`/api/p5/tenancy`, `/api/d1/clients`, `/api/d1/reporting`, `/api/d2/ops-reporting` have no TSX callers).
2. **Filing transport stubs remain active** (`TODO(firm)`, `_stub`, `blocked_todo_firm`) and affect filing-linked slices touched in this batch.

## DoD rubric used

- `BACKEND_REAL`: concrete route + repository behavior with focused tests.
- `FRONTEND_REAL`: `/ops` or other UI path actually calls the API family.
- `no silent stubs`: no `TODO(firm)` / `_stub` / `blocked_todo_firm` in claimed operational surface.
- `SHA on main`: claimed merge SHA is ancestor of `main`.

## PR-by-PR classification

| PR | Claimed phase | Merge SHA | SHA on `main` | BACKEND_REAL | FRONTEND_REAL | no silent stubs | UI coverage note | Final | Severity |
|---|---|---|---|---|---|---|---|---|---|
| #38 | Follow-up source persistence | `f78abce` | PASS | PASS | FAIL | PASS | `/ops` calls `/api/d1/matters` create only; no UI action for `confirm_engagement` / `record_case_number` source-persistence path | PARTIAL | major |
| #39 | Membership persistence | `f93ec73` | PASS | PASS | PASS | FAIL | `/ops` exercises matters/documents/workflow/drafts/court-ops/filings routes, but touched filing surface still carries transport stubs | PARTIAL | blocker |
| #40 | Tenancy membership | `2a411b5` | PASS | PASS | FAIL | PASS | No UI caller for `/api/p5/tenancy` membership views | PARTIAL | major |
| #41 | Tenancy audit | `e0ee204` | PASS | PASS | FAIL | PASS | No UI caller for `/api/p5/tenancy` audit view | PARTIAL | major |
| #42 | Entity/client persistence | `b895247` | PASS | PASS | FAIL | PASS | No UI caller for `/api/d1/clients` | PARTIAL | major |
| #43 | Audit write-through non-tenancy | `9ed9195` | PASS | PASS | PARTIAL | FAIL | `/ops` covers most touched write routes; no `/api/d1/clients` UI caller; filing-linked writes still include stub transport states | PARTIAL | blocker |
| #44 | Committee-brain output persistence | `a48f868` | PASS | PASS | PARTIAL | PASS | Foundation console calls `/api/p1/committee-brain` POST; no UI surface for persisted list/hydration read path | PARTIAL | major |
| #45 | Matter/client reporting + search index | `2d2d0a8` | PASS | PASS | FAIL | PASS | No UI caller for `/api/d1/reporting` or `/api/d1/clients` | PARTIAL | major |
| #46 | Draft template analytics | `b896b60` | PASS | PASS | PASS | PASS | `/ops` drives `/api/d4/drafts` template read + compose + drafts read (analytics exercised) | PARTIAL | major |
| #47 | Workflow ops reporting | `be269a9` | PASS | PASS | FAIL | PASS | No UI caller for `/api/d2/ops-reporting` | PARTIAL | major |

## Backend reality evidence (non-scaffold)

- Each merged PR maps to substantive implementation commits with route/persistence/test deltas (not docs-only).
- Runtime persistence adapters are present in both memory and Firestore repositories for follow-ups, memberships, tenancy audit, entity links, audit log, committee outputs, search index, draft analytics, and workflow ops activity.
- Focused runtime-mode tests prove reset-safe rehydration for all key batch claims.

## Policy cap applied to completion labels

Even where a slice is otherwise backend-real and UI-covered, this audit keeps final classification at **PARTIAL** while filing transport stubs (`TODO(firm)`, `_stub`, `blocked_todo_firm`) remain in active operational surfaces.

## Focused verification executed

### Targeted tests run

1. `npx vitest run tests/api.matters.test.ts tests/api.tenancy.test.ts tests/api.clients.test.ts tests/api.reporting.test.ts tests/api.committee-brain.test.ts tests/api.drafts.test.ts tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts`
2. `npx firebase emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.runtime-mode.test.ts -t 'persists draft template analytics|persists workflow/court-ops activity index|persists follow-up and intimation creation at source|hydrates permission checks from persisted matter memberships|persists and rehydrates entity/client registry data|persists matter/client search index rows|persists non-tenancy audit actions|persists committee-brain outputs|hydrates tenancy membership, roles, and audit views'"`
3. `bash ci_gates/gate_g0.sh`
4. `python3 ci_gates/gate_g1.py`

All commands passed.

### Evidence artifacts

- `/opt/cursor/artifacts/phase-sample-38-47-sha-main.log`
- `/opt/cursor/artifacts/phase-sample-38-47-diffstat.log`
- `/opt/cursor/artifacts/phase-sample-38-47-ui-coverage.log`
- `/opt/cursor/artifacts/phase-sample-38-47-stub-scan.log`
- `/opt/cursor/artifacts/phase-sample-38-47-focused-api-tests.log`
- `/opt/cursor/artifacts/phase-sample-38-47-runtime-tests.log`
- `/opt/cursor/artifacts/phase-sample-38-47-gates.log`
