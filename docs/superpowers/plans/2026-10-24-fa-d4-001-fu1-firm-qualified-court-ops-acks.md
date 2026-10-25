# FA-D4-001-FU1 Implementation Plan: firm-qualified court-ops acknowledgements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (owner's standing instruction:
> autonomous, inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Firm A can no longer overwrite, plant or nest a court-ops acknowledgement row of firm B. Legacy rows are moved
or reported.

**Architecture.**
- **Route.** `POST /api/d2/court-ops acknowledge_item` does four things in order:
  - validates `queueType`, `id` and `reason`;
  - resolves the item in the caller's firm (404 otherwise);
  - writes `ops:court_ops:ack:{firmId}:{queueType}:{itemId}` through ONE transactional, firm-checked repository method;
  - pushes its audit row only after that commit.
- **Rules.** A get of an ack row must match its own firm-qualified id.
- **Backfill.** A dry-run-by-default backfill on the F13-003 / FA-D4-001 pattern moves legacy rows and reports the
  rest by id.

**Tech stack.** Next route handlers, Firestore (Admin SDK through `platform/persistence/firestoreDbModular.ts`),
Firestore rules, vitest under the Auth and Firestore emulators.

**Spec.** `docs/superpowers/specs/2026-10-24-fa-d4-001-fu1-firm-qualified-court-ops-acks-design.md` (rulings R1–R15).

## Global Constraints

- **Ack id.** `ops:court_ops:ack:${firmId}:${queueType}:${itemId}`.
  - `queueType` is in {`follow_up`, `workflow`}.
  - `itemId` is 1–256 UTF-8 bytes, with no `:` and no `/`.
  - `firmId` is non-empty and unpadded, with no `:` and no `/`.
- **Error codes.**

  | Status | Code |
  |---|---|
  | 400 | `court_ops_queue_type_invalid` |
  | 400 | `court_ops_item_id_invalid` |
  | 400 | `court_ops_reason_invalid` |
  | 404 | `court_ops_item_not_found` |
  | 409 | `court_ops_ack_refused` (reason `foreign_firm` \| `malformed`) |
  | 503 | `court_ops_ack_unavailable` |

- **Names.** The collection stays `workflow_ops_activity` (F42 gate). Backfill exit codes are 0 clean, 1 retry, and 2
  needs operator review (2 wins).
- **Environment.**
  - Private emulator ports: firestore 8097, auth 9097, hub 4091, logging 4093, websocket 8098, functions 5697.
  - Project `demo-fa-d4-001-fu1`.
  - No `npm ci` or `npm install`. Run vitest with `--no-cache`.

## Review Focus

1. **A planted row at a firm's own id.** On main, firm A could write `queueType=<B's firmId>, id="workflow:X"`. After
   the fix, B's acknowledgement of X must answer 409 and leave the planted row as it was. Pinned in Task 2 (e2e
   "planted row").
2. **Concurrent acknowledgements by two firms of their own items, plus same-firm repeats.** Each firm ends with
   exactly one row per item, and every answer is 200. Pinned in Task 2 (e2e "concurrent").
3. **A failed write must leave no "acknowledged" audit row (R7).** Pinned in Task 2 on the memory path, with a
   throwing writer.
4. **An existing nested FU1b document under an ack parent.** The backfill must report it, not crash. Pinned in Task 4
   (backfill "nested").
5. **A legacy row whose item belongs to another firm.** It must never be moved under the stamped firm. Pinned in
   Task 4 (backfill "item_not_in_firm").

---

## RED/GREEN ledger

Counts are filled from the runs. RED is run on the detached main worktree with the new test files copied in, or on
this branch before the source change. RED was first taken on 6b186a0 and taken again on 798cf56 after the merge, with
the same counts. GREEN is run on this branch's head.

| Suite | RED on main | GREEN on branch |
|---|---|---|
| e2e `tests/fa-d4-001-fu1-court-ops-acks.e2e.firestore.test.ts` | see PR body | see PR body |
| rules `tests/fa-d4-001-fu1-court-ops-acks.rules.firestore.test.ts` | see PR body | see PR body |
| backfill `tests/fa-d4-001-fu1-court-ops-acks-backfill.e2e.firestore.test.ts` | cannot load on main (module absent) | see PR body |
| unit `tests/fa-d4-001-fu1-court-ops-acks.unit.test.ts` | cannot load on main (module absent) | see PR body |

---

### Task 1: The ack id, the validator and the writer decision (pure module)

**Files:**
- Create: `platform/persistence/courtOpsAcknowledgement.ts`
- Test: `tests/fa-d4-001-fu1-court-ops-acks.unit.test.ts`

**Interfaces (produces):**
- `COURT_OPS_ACK_PREFIX = "ops:court_ops:ack:"`
- `COURT_OPS_ACK_QUEUE_TYPES = ["follow_up", "workflow"] as const`
- `type CourtOpsAckQueueType`
- `isCourtOpsAckQueueType(v: unknown): v is CourtOpsAckQueueType`
- `courtOpsAckItemIdProblem(id: unknown): string | null`. Returns null when the id is valid.
- `courtOpsAckId(firmId: string, queueType: CourtOpsAckQueueType, itemId: string): string`. Throws
  `CourtOpsAckIdError` (code `court_ops_ack_id_invalid`).
- `legacyCourtOpsAckId(queueType: string, itemId: string): string`. The pre-fix id.
- `isCourtOpsAckPath(id: string): boolean`. True when the id starts with the prefix.
- `readCourtOpsAckRow(id: string, data: unknown): WorkflowOpsActivityRow | null`. The one validator. It also requires
  `id === courtOpsAckId(row.firmId, row.queueType, itemOf(row))`.
- `readLegacyCourtOpsAckRow(id: string, data: unknown): WorkflowOpsActivityRow | null`. The same validator, but against
  the legacy id. The returned row is re-keyed to its canonical id.
- `class CourtOpsAckRefusedError`. Has `code = "court_ops_ack_refused"`, `ackId` and
  `reason: "foreign_firm" | "malformed"`.
- `nextCourtOpsAckRow(firmId: string, next: WorkflowOpsActivityRow, stored: unknown): WorkflowOpsActivityRow`. Its
  three cases:
  - stored firm ≠ caller firm: refused (`foreign_firm`);
  - stored row not canonical: refused (`malformed`);
  - `next` not canonical, or `next.firmId` ≠ the caller firm: throws `CourtOpsAckIdError`;
  - otherwise returns `next`.

- [ ] **Step 1. Write failing unit tests.**
  - Id build and parse round-trip.
  - Refusal of `:`, `/`, the empty string, 257 bytes and padded firms.
  - The validator refuses a legacy id, a mismatched firm, a mismatched item, an unknown queue and a non-string
    detail.
  - `nextCourtOpsAckRow` covers all three cases.
- [ ] **Step 2.** Run `npx vitest run --no-cache tests/fa-d4-001-fu1-court-ops-acks.unit.test.ts`. Expect FAIL
  (module not found).
- [ ] **Step 3.** Implement the module.
- [ ] **Step 4.** Rerun. Expect PASS.

### Task 2: The repository writer, the route and the e2e (FU1 / FU1b)

**Files:**
- Modify: `platform/persistence/spineRepositories.ts`
  - `WorkflowOpsActivityRepository` gains
    `recordCourtOpsAcknowledgement(firmId: string, row: WorkflowOpsActivityRow): Promise<WorkflowOpsActivityRow>`.
  - In the memory repository: `upsert` refuses ack paths; `get` and `listByFirm` keep only canonical ack rows.
- Modify: `platform/persistence/firestoreSpineRepositories.ts`. Same four changes: `runTransaction`, `tx.get`,
  `nextCourtOpsAckRow`, `tx.set`.
- Modify: `services/d2-2/courtOps.ts`.
  - Add `resolveCourtOpsAckItem(store, {actorId, queueType, id})`, which returns
    `{ actor, documentId, followUpId }`. It throws `CourtOpsItemNotFoundError` (code `court_ops_item_not_found`).
  - `acknowledgeCourtOpsItem` keeps its role check and audit push. It is called after the commit.
- Modify: `app/api/d2/court-ops/route.ts`, the `acknowledge_item` branch. Its errors:

  | Condition | Answer |
  |---|---|
  | Invalid `queueType`, `id` or `reason` | 400 |
  | Item not found | 404 |
  | `CourtOpsAckRefusedError` | 409 and one `console.error` line |
  | Any other writer error | 503 |

- Test: `tests/fa-d4-001-fu1-court-ops-acks.e2e.firestore.test.ts`. It uses the real route in production modes and
  seeds `follow_ups`, `document_workflow` and `documents` rows through the Admin SDK.
- Test: `tests/api.court-ops.test.ts`, memory path.
  - New case "a failed ack write leaves no court_ops_acknowledge audit row and answers 503".
  - New case "an ack of another firm's follow-up answers 404".
- Modify: `vitest.config.ts` (emulator exclude list) and `package.json` (`test:rules` list).

- [ ] **Step 1. Write the e2e.**
  - **FU1.** B acknowledges its own workflow item X (200, row at `ops:court_ops:ack:{B}:workflow:{X}`). A sends X
    (404). B's row is unchanged, the legacy id `ops:court_ops:ack:workflow:X` does not exist, and A has no row.
  - **Own rows.** A and B each acknowledge their own follow-up and workflow items, and each row sits at its own
    firm-qualified id.
  - **FU1b.**
    - The ids `p/sub/d`, `a:b`, the empty string and 300 bytes answer 400.
    - The queue types `zz` and `follow_up ` answer 400.
    - A numeric `reason` answers 400.
    - None of them writes anything, nested documents included.
  - **Unknown item.** An unknown id answers 404 and writes nothing.
  - **Concurrent.** 3 acknowledgements per firm in flight together, on each firm's own item. All answer 200, each
    firm has one row, and its content equals one of its requests.
  - **Planted row.** A `firmId: A` row is set at B's canonical id. B's acknowledgement answers 409
    `court_ops_ack_refused`, and the row is unchanged.
  - **Authority path.** The `x-authority-path` header is `functions`.
- [ ] **Step 2. Run RED on main.** Copy the file into `scratchpad/fu1/main-6b186a0/tests/`, then run
  `run-emu.sh main red-e2e tests/<file>`. Expect failures: overwrite, 200 on `/`, 200 on unknown.
- [ ] **Step 3. Implement** the repositories, the service and the route.
- [ ] **Step 4.** Run `run-emu.sh branch green-e2e tests/<file>` and `npx vitest run --no-cache tests/api.court-ops.test.ts`.
  Expect PASS.
- [ ] **Step 5. Commit and push.**

### Task 3: Rules

**Files:**
- Modify: `firestore.rules`, the `match /workflow_ops_activity/{id}` block.
  - `allow get: if <existing> && courtOpsAckIdOk(id)`
  - `allow list: if <existing>`
  - `allow write: if false`
- Modify: `tests/firestore.rules.matter-scope-coverage.test.ts`. `readCondition` checks every
  `allow (read|get|list): if` condition of the block.
- Test: `tests/fa-d4-001-fu1-court-ops-acks.rules.firestore.test.ts`. It covers:
  - A's staff get A's canonical row;
  - A cannot get B's row;
  - a legacy ack row and a mismatched one cannot be read by get, by either firm;
  - list with `firmId == A` succeeds for A and is refused for B;
  - non-ack rows (`ops:workflow_event:…`) are still readable by get;
  - no client can create, update or delete;
  - an intern is refused, as `matterScoped` already allows interns. Check before asserting.

- [ ] **Step 1. Write the rules test.** Run RED against main's rules (`run-emu.sh main`). Expect the legacy and
  mismatched get cases to FAIL.
- [ ] **Step 2. Implement** the rule. Run GREEN. Also run `tests/firestore.rules.matter-scope-coverage.test.ts` and
  `tests/firestore.rules.test.ts`.
- [ ] **Step 3. Commit and push.**

### Task 4: Backfill

**Files:**
- Create: `platform/persistence/courtOpsAckBackfill.ts`. It is pure.
  - `planCourtOpsAckBackfill(rows, nested, itemFirms)`
  - `formatCourtOpsAckBackfillDryRun(plan)`
  - `decideCourtOpsAckMove(planned, legacyStored, targetStored)`
  - `applyCourtOpsAckBackfill(store, plan, meta)`
  - `courtOpsAckBackfillExitCode(plan, result?)`
- Create: `scripts/lib/courtOpsAckBackfillAdmin.ts`. The Admin SDK side.
  - Reads ack-prefixed rows.
  - Walks nested documents under ack-prefixed parents.
  - Reads `document_workflow` and `follow_ups` evidence.
  - Holds the move transaction and creates audit rows.
- Create: `scripts/lib/courtOpsAckBackfillCli.ts`, which provides `runCourtOpsAckBackfill(argv, deps): Promise<0|1|2>`.
- Create: `scripts/backfill-court-ops-acks.ts`.
- Modify: `package.json`, adding `backfill:court-ops-acks`.
- Test: `tests/fa-d4-001-fu1-court-ops-acks-backfill.e2e.firestore.test.ts`. It covers:
  - the dry run names every class and writes nothing;
  - apply moves, merges (keeps the later), deletes legacy, and is idempotent (a rerun moves 0);
  - `item_not_in_firm`, `malformed`, `nested` and `target_conflict` are reported, left, and exit 2;
  - a failed move exits 1 and prints "rerun to retry";
  - a clean run exits 0;
  - the output carries no `detail` text.

- [ ] **Step 1. Write the tests.** RED: the module is absent.
- [ ] **Step 2. Implement.** GREEN.
- [ ] **Step 3. Commit and push.**

### Task 5: Mutation, gates, evidence, PR body

- [ ] **Mutation.** At least 10 hand mutants. For each one:
  - apply it with `sed` to a scratch copy;
  - run the owning suite;
  - record whether it was killed;
  - restore the file (verify with `git diff --stat`).
- [ ] **Gates.**
  - `npx tsc --noEmit -p tsconfig.json`, plus the tests tsconfig if CI uses it.
  - `npx eslint --max-warnings 0 <touched files>`.
  - The neighbour suites: court-ops API, F02 authority unit and e2e, F12, F13, `firestore.rules*`, G-2
    (`functions/test/g2.cross-firm.test.ts` and `tests/g2.cross-firm.test.ts`).
  - `BASE=origin/main bash ci_gates/gate_g0.sh`.
  - gitleaks.
  - `python3 ci_gates/check_pr_phase_claims.py` on the PR body.
- [ ] **Evidence.** Write the evidence log and the PR body to the scratchpad paths in the brief.
