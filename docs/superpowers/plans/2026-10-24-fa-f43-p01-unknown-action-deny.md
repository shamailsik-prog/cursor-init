# FA-F43-R1-P01: unknown action denied, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Executed natively (owner's autonomy ruling).

**Goal:** `decide()` ends in `deny("unknown-action")` in both stacks, every legitimate fall-through action has an explicit row, and a G-0 gate keeps every call-site action in the table.

**Architecture:** One shared table (`platform/p5/permissionDecision.ts`) gains `NEXT_ROUTE_ACTIONS` with its role table, an `ACCOUNTS_ACTIONS` list, `DECIDE_ACTIONS` / `isKnownAction`, and a default deny. Functions inherits it through `functions/src/p5/permission.ts`. A Python G-0 check walks every call into the P5 entry points and resolves each action statically.

**Tech Stack:** TypeScript (Next.js 16 app, Cloud Functions bundle), vitest 3, Firebase emulators, Python 3.12 (G-0).

**Spec:** `docs/superpowers/specs/2026-10-24-fa-f43-p01-unknown-action-deny-design.md`

## Global Constraints

- The two F42 mutant anchors stay byte-identical: `if (matter.deleted === true) return deny("matter-deleted")` and `if (isFirmAdminAction(action) || isRetentionAction(action)) {` (`functions/test/f42-mutants.json`).
- Reason codes kept: `intern-channel-denied`, `client-channel-denied`, `staff-only`, `client-own-matters`, `accounts-register-only`, `accounts-register`; new: `unknown-action`.
- G-0 check number [23]; G-0 static runs without `node_modules`.
- Emulators: firestore 8297, auth 9297, hub 4291, logging 4293, websocket 8298, functions 5397, project `demo-fa-f43-p01`, UI off.
- No `npm ci` / `npm install`; vitest with `--no-cache`.

## Review Focus

1. A route that passes its action through a wrapper with an untyped parameter: the gate must fail it (`computed_action`), not pass it. Pinned in Task 3's fixtures.
2. A relative import of the Functions entry (`./permission` from `functions/src/p5/common.ts`): the gate must still track it. Pinned in Task 3's fixtures.
3. An accounts caller with an unknown action: keeps `accounts-register-only` (not `unknown-action`). Pinned in Task 1.
4. A committee decision with no matter named: `cross-firm`, never `ok`. Pinned in Task 1.
5. `--print-known` drifting from the TypeScript list: the unit test compares them. Pinned in Task 3.

---

### Task 1: The decision table (unit RED/GREEN)

**Files:**
- Modify: `platform/p5/permissionDecision.ts` (new lists, rows, default deny, header comment)
- Modify: `platform/p5/committeeScope.ts:65-71` (type of `action`)
- Modify: `functions/src/p5/permission.ts` (doc comments only)
- Create: `tests/fa-f43-p01-unknown-action.test.ts`
- Modify (changed expectations): `tests/p5.checkPermission.decision-table.test.ts`, `tests/p5.permission-decision.parity.test.ts`, `tests/p5.committeeScope.test.ts`

**Interfaces:**
- Produces: `NEXT_ROUTE_ACTIONS` (`as const`: `list_matters`, `research`, `draft`, `normalise_case_number`, `committee_brain`, `committee_brain_read`), `type NextRouteAction`, `isNextRouteAction(action: string): action is NextRouteAction`; `type CommitteeBrainAction = "committee_brain" | "committee_brain_read"`; `ACCOUNTS_ACTIONS` (`as const`) with `ACCOUNTS_REGISTER_ACTIONS: ReadonlySet<string>` built from it; `DECIDE_ACTIONS` (`as const` spread of every family list), `type DecideAction`, `isKnownAction(action: string): action is DecideAction`.

- [ ] **Step 1: Write the failing tests** in `tests/fa-f43-p01-unknown-action.test.ts`:
  - `an action no table knows is refused unknown-action for every role but accounts` — for `fa_f43_unknown.action`, `read`, `read_matter`, `constructor`, `__proto__`, with and without a member matter: partner, associate, clerk, intern, client → `{ allow: false, reason: "unknown-action" }`; accounts → `accounts-register-only`; `null` → `no-user`.
  - `Next checkPermission audits the refusal` — store row reason `deny:fa_f43_unknown.action:unknown-action`, `action: "permission_check"`.
  - `each Next route action keeps exactly its ruled roles` — the R2 table, member matter, cleared: allowed roles `ok` (list_matters for client: `client-own-matters`); refused ones with the R3 reasons (`committee_brain` intern → `role-not-permitted`, client → `client-denied`).
  - `the committee actions must name a matter` — no matter → `cross-firm` for partner.
  - `the accounts register actions are accounts only` — staff → `role-not-permitted`, accounts → `accounts-register`.
  - `DECIDE_ACTIONS is exactly what the table decides` — every listed action, every role, member matter: reason is never `unknown-action`; `isKnownAction` agrees with the list.
  - `alert.read and alert.ack stay partner only` (GREEN on main too).
- [ ] **Step 2: Run against main's production files** (`git checkout origin/main -- platform/p5/permissionDecision.ts platform/p5/committeeScope.ts functions/src/p5/permission.ts`): expected FAIL (the imports of the new names are undefined; the fall-through allows). Restore with `git checkout HEAD -- …`.
- [ ] **Step 3: Implement** the rows in spec R1-R8. Order inside the Next-route block: intern research/draft → `intern-channel-denied`; client or `own_matters` → `client-own-matters` / `staff-only` / `client-channel-denied` / `client-denied`; then the matter gate (committee actions always, the others when a matter is named, `list_matters` never); then the role table. Remove the `client-research-denied` row. Last line `return deny("unknown-action")`.
- [ ] **Step 4: Update the changed expectations** (spec R13) and run `npx vitest run --no-cache tests/p5.* tests/fa-f43-p01-unknown-action.test.ts tests/security.accounts-role.test.ts tests/spine.hardening.test.ts`: expected PASS.
- [ ] **Step 5: Commit.**

### Task 2: The Functions stack on the emulator (RED/GREEN)

**Files:**
- Modify: `functions/test/p5.permission.test.ts` (new describe; `read_matter` → `matter.read`)
- Modify: `functions/test/p5.security-gaps.emu.test.ts` (`read_matter` → `matter.read`; the fall-through cases now assert refusal)

- [ ] **Step 1: Write** `FA-F43-R1-P01: an action no table knows is refused, with an audit_log deny row` — for partner, associate, clerk, intern, client: `checkPermission(c, "fa_f43_unknown.action", matterId)` (member matter) → `{ allow: false, reason: "unknown-action" }` and one `audit_log` row `{ action, decision: "deny", reason: "unknown-action", target: "matters/<id>" }`; `requirePermission(c, "fa_f43_unknown.action" as never)` → 403 `unknown_action`. `afterAll` → `deleteFirmData(firms, [])`.
- [ ] **Step 2: Run on main's files** under the private emulators: expected FAIL (allow ok).
- [ ] **Step 3: Run on the branch:** expected PASS, and the whole file passes.
- [ ] **Step 4: Commit.**

### Task 3: The parity gate, G-0 [23]

**Files:**
- Create: `ci_gates/check_permission_actions.py`, `ci_gates/test_check_permission_actions.py`, `tests/fa-f43-p01-permission-actions-gate.test.ts`
- Modify: `ci_gates/gate_g0.sh` (check [23])

**Interfaces:**
- Produces: `scan(root: pathlib.Path) -> list[Finding]` (`Finding(rel, line, kind, detail)`), `known_actions(root) -> list[str]`, `inventory(root) -> list[dict]`; CLI flags `--print-known`, `--print-inventory`, `--root <dir>`.

- [ ] **Step 1: Write the fixtures** (`test_check_permission_actions.py`): must fail — unlisted literal (`unknown_action`), untyped `const a = "research"` (`computed_action`), template string (`template_action`), typed union with an unknown member (`unknown_action`), member expression (`computed_action`), namespace import (`untracked_binding`), escaped reference (`escaped_reference`), stale listing (`stale_listing`); must pass — known literal, typed alias, relative `./permission` import with a known literal, a typed default parameter.
- [ ] **Step 2: Write** `tests/fa-f43-p01-permission-actions-gate.test.ts`: `--print-known` equals `DECIDE_ACTIONS` (sorted); the gate passes on the tree (exit 0); the inventory names `committee_brain`, `committee_brain_read`, `normalise_case_number`, `research`, `draft`, `list_matters`.
- [ ] **Step 3: Run both:** expected FAIL (no script).
- [ ] **Step 4: Implement** the walker (spec R9): comment-aware tokenizer (strings, templates with `${}`, regex literals), import resolution by path, call argument split at top level, nearest-declaration annotation resolution, the two listed forwards.
- [ ] **Step 5: Run both:** PASS. Run the gate against main's tree (a `git worktree`-free copy: `git archive origin/main platform functions/src app services lib core components | tar -x -C <tmp>`): expected FAIL.
- [ ] **Step 6: Wire [23]** into `ci_gates/gate_g0.sh` (the checker and its fixture test, as [22]); run `BASE=origin/main bash ci_gates/gate_g0.sh`: PASSED.
- [ ] **Step 7: Commit.**

### Task 4: Real routes under the emulator (GREEN guards)

**Files:**
- Create: `tests/fa-f43-p01-next-routes.e2e.firestore.test.ts`
- Modify: `vitest.config.ts` (emulator-only exclusion), `package.json` (`test:rules` list)

- [ ] **Step 1: Write** one firm (`beforeAll`) with partner, associate, clerk, intern, client, accounts users (Firebase sessions, `SIKANDER_PERSISTENCE_MODE=firestore`), one member matter, a `follow_ups` row and a `drafts` row on it; `afterAll` deletes the firm's rows and users. Cases: POST `/api/g0/normalise` (200 for the four staff, 403 `staff-only` client, 403 `accounts-register-only` accounts); POST then GET `/api/p1/committee-brain` (200 and listed for partner, associate, clerk; a non-member clerk 403 `not-member`; intern refused by the route); GET `/api/d1/matters` (the matter listed for the staff members); GET `/api/d2/court-ops` (the follow-up listed for partner, associate, clerk); GET `/api/d4/drafts` (the draft listed for partner, associate, clerk; not for the intern).
- [ ] **Step 2: Run on main's files and on the branch** under the private emulators: PASS on both (regression guard).
- [ ] **Step 3: Commit.**

### Task 5: Mutation, verification, PR body

- [ ] **Step 1:** At least 10 mutants (default deny, each new row, the gate walker), applied one at a time; record killed/survived with the killing test.
- [ ] **Step 2:** Typecheck (root, tests, functions), eslint `--max-warnings 0` on touched files, root unit suite, `test:rules`, Functions `test:emu`, G-0, G-1, G-2, gitleaks, the claim gate.
- [ ] **Step 3:** Write the PR body and the evidence log; push.

## RED/GREEN ledger

Measured 2026-10-25 ("main" = main's three P5 production files, `platform/p5/permissionDecision.ts`,
`platform/p5/committeeScope.ts`, `functions/src/p5/permission.ts`, put back over the branch; they are identical on 5840d3d
and 4a12508).

| # | Test | Main | Branch |
|---|---|---|---|
| 1 | `tests/fa-f43-p01-unknown-action.test.ts` | 28 of 39 fail | 39 of 39 pass |
| 2 | `functions/test/p5.permission.test.ts` FA-F43-R1-P01 describe (emulator, audit_log rows) | 7 of 7 fail | 7 of 7 pass |
| 3 | `tests/fa-f43-p01-permission-actions-gate.test.ts` | 3 of 3 fail | 3 of 3 pass |
| 4 | `ci_gates/test_check_permission_actions.py` on main's tree | 2 of 30 fail (the shipped-tree cases; the 28 planted trees are tree-independent) | 30 of 30 pass; 32 of 32 after the two escape-spelling fixtures (RED 2 of 32 on the gate's first tokenizer, GREEN on `js_lexer`) |
| 5 | `ci_gates/check_permission_actions.py` | main's tree: `no_table`; main's tree with the branch table: `computed_action` at `committeeScope.ts:79` | PASS, 241 call sites |
| 6 | `tests/fa-f43-p01-next-routes.e2e.firestore.test.ts` (emulator) | 5 of 5 pass (guard) | 5 of 5 pass |
| 7 | Changed expectations: parity, decision-table, committee-scope (root); security-gaps (Functions) | 14 + 2 + 1 + 2 fail | all pass |

Mutation: 28 mutants (16 on the table and `canAccessMatter`, 12 on the gate's walker and its `js_lexer` adapter), 28 killed; G1-G12 rerun on the lexer-based gate after merging main ba27912.
