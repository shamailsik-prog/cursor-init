# FA-F42-R1-015 — F42 deletion e2e: `otherFirm` (`uniq("f42x")`) and low-clearance auth user cleanup

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-015** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

Commit **`301e65d`** (`test(F42): clean up the retention e2e firms so later suites stay fast`) introduced `afterAll` cleanup via `deleteFirmScopedData(firms, uids)` on `functions/test/f42-retention-deletion.e2e.emu.test.ts`, but two resources created inside individual tests were **not** registered:

| Resource | Where created | Leak per run |
| --- | --- | --- |
| `otherFirm = uniq("f42x")` | Saga isolation case: `seedStores(otherFirm, …)` (~11 inventoried rows with `firmId` = that id) | Firestore rows keyed by an unlisted firm id |
| `low` partner (`mintIdToken` with `clearanceLevel: "public"`) | Authorisation case: clearance gate on `approveMatterDeletion` | One Auth emulator user |

Neither id was pushed to the file-level `firms` / `uids` arrays, so `afterAll` never deleted them. On a long-lived shared emulator this inflated firm-scoped scans and Auth user counts for downstream suites (same class of problem as the original `301e65d` motivation).

Spec **R35** requires every F42 e2e suite to tear down everything it creates.

## Correction

Implemented on main in **#133** (`d3b87dbb`, commit `3d306fa6` within that merge):

- `firms.push(otherFirm)` immediately after `uniq("f42x")` in the saga isolation test.
- `uids.push(low.uid)` immediately after minting the low-clearance partner in the authorisation test.

No change to production retention code; only test harness bookkeeping.

**Scope (investigated on tip `83f0f805`):** `uniq("f42x")` appears only in `f42-retention-deletion.e2e.emu.test.ts`. Other F42 emulator suites (`f42-r1-followup`, `f42-r2-followup`, `f42-retention-apply`) route firms through `newFirm()` / `firmFor()` or explicit `firms.push` and route auth users through `member()` / `uids.push`. The Next-side follow-up (`tests/f42-r1-followup-next.e2e.firestore.test.ts`) tracks `created` + `authUsers` in `afterAll`.

**Guard:** `functions/test/f42-e2e-cleanup.unit.test.ts` fails if either `firms.push(otherFirm)` or `uids.push(low.uid)` is removed from the deletion e2e source, if `afterAll` does not call `deleteFirmScopedData(firms, uids)` inside a **single file-top-level** `afterAll(async () => { … })` hook body (mutants **M4** empty arrays, **Mmove** / **MmoveT** call relocated to `it.skip` at EOF — PR **#187** killed **Mmove** but not **MmoveT**, where an empty `afterAll` plus `it.skip(…, async () => { … deleteFirmScopedData … }, 120_000)` let a naive `[\s\S]*?` span cross the real hook close; PR **#188** tempered on `}, 120_000)` only, so **MmoveNoTO** / **MmoveOtherTO** could change or drop the hook timeout and still match the trailing `}, 120_000)` on a moved `it.skip`; **FA-F42-R1-015-001-001-001-001** adds TypeScript AST proof that the call lives under an `afterAll(async () => { … })` body plus regex tempering on **any** `}\s*,\s*<digits>` hook close, not only `120_000`; residual **FA-F42-R1-015-001-001-001-001-001** restricts AST to top-level hooks so **MdescribeSkip** cannot pass), or if the deletion-e2e afterAll wiring is checked with the pre-#188 vacuous `afterAll[\s\S]*?deleteFirmScopedData` regex instead of the shared `assertF42DeletionE2EAfterAllWiring` helper and `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` constant (**FA-F42-R1-015-001-001-002**, ME REAUDIT_PR187 — fixture tests already imported the tempered constant, so reverting only the production `expect(src).toMatch(...)` line did not fail CI until the meta pin landed).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-015 | `301e65d` afterAll missed `f42x` firm rows and `low` auth user |
| RED | `301e65d` `f42-retention-deletion.e2e.emu.test.ts` | `otherFirm` seeded but not `firms.push`; `low` minted but not `uids.push` |
| GREEN | Spec R35 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | E2e suites clean up everything they create |
| GREEN | `functions/test/f42-retention-deletion.e2e.emu.test.ts` | `firms.push(otherFirm)` + `uids.push(low.uid)` with FA-F42-R1-015 comments |
| GREEN | `functions/test/f42-e2e-cleanup.unit.test.ts` — `FA-F42-R1-015` | Source contract guard |

### Mutants that must stay killed

| Mutant | Guard |
| --- | --- |
| Drop `firms.push(otherFirm)` or `uids.push(low.uid)` | Push-order regex assertions |
| **M4** — `afterAll` calls `deleteFirmScopedData([], [])` (arrays never consumed) | AST + `afterAll` hook body must call `deleteFirmScopedData(firms, uids)` before any `}\s*,\s*<timeout>)`; literal empty-array call forbidden |
| **Mmove** — move `deleteFirmScopedData(firms, uids)` out of `afterAll` into bare `it.skip` at EOF (FA-F42-R1-015-001-001) | `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` + `deleteFirmScopedDataInAfterAllAsyncHook`; dedicated fixture test |
| **MmoveT** — empty `afterAll(async () => {}, 120_000)`; cleanup in `it.skip(…, async () => { … }, 120_000)` at EOF so the old `[\s\S]*?` body span matched the skip’s timeout close | Same guards with hook-close tempered prefix on any numeric timeout; dedicated **MmoveT** fixture test |
| **MmoveNoTO** — empty `afterAll(async () => {})` (no timeout); cleanup in `it.skip(…, 120_000)` | `deleteFirmScopedDataInAfterAllAsyncHook` (AST); regex cannot temper a comma-less `})` hook close without false negatives — dedicated fixture test (**FA-F42-R1-015-001-001-001-001**) |
| **MmoveOtherTO** — empty `afterAll(async () => {}, 60_000)`; cleanup in `it.skip(…, 120_000)` | Tempered prefix `(?!\}\s*,\s*[\d_]+\s*\))` + AST; dedicated fixture test (**FA-F42-R1-015-001-001-001-001**) |
| **MdescribeSkip** — `deleteFirmScopedData(firms, uids)` only inside `afterAll` nested under `describe.skip` (hook never runs) | `deleteFirmScopedDataInAfterAllAsyncHook` requires exactly one **file-top-level** `afterAll(async () => { … })` with the call (rejects nested hooks); dedicated fixture test (**FA-F42-R1-015-001-001-001-001-001**, PR after #189 / `86777c5f`) |
| **MvacuousReintro** — replace tempered production check with vacuous `afterAll[\s\S]*?deleteFirmScopedData(firms, uids)` on the real e2e file (still passes **MmoveT**) | `assertF42DeletionE2EAfterAllWiring` + meta pin **FA-F42-R1-015-001-001-002** (helper must call `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD`; M4 test must delegate to helper; **MmoveT** control proves vacuous regex alone is insufficient) |
| **MvacuousConstInHelper** — swap `expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)` for `VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` in the shared helper while leaving meta pin / fixtures unchanged | Meta pin **FA-F42-R1-015-001-001-002-001**: word-boundary token `\bAFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b` (not substring `toContain`); helper must not reference `\bVACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b`; dedicated mutant fixture test |
| **MshadowAltSyntax** — declare `const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /afterAll[^]*?…/` inside the helper so token pin passes while `expect(src).toMatch` uses the shadow regex, not the module export | Meta pin **FA-F42-R1-015-001-001-002-001-001**: AST forbids local bindings of `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` in the helper; `expect(src).toMatch` must take that identifier; forbids `\[\^]` alt-regex span and vacuous pattern literals in helper text; dedicated fixture test |
| **MshadowParam** — default parameter (or plain parameter) named `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` shadows the module export while `expect(src).toMatch` still names that identifier | Meta pin **FA-F42-R1-015-001-001-002-001-001-001**: helper parameter / destructure binding scan + TypeChecker proof that `toMatch` resolves to the exported const; dedicated fixture test |
| **MshadowDestructure** — `const { AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = … }` (or param object destructure) shadows the export with the same identifier in `toMatch` | Same pin as **MshadowParam**; dedicated fixture test **FA-F42-R1-015-001-001-002-001-001-001** |
| **MtoSatisfy** — helper keeps `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` only in a comment and uses `expect(/vacuous/.test(src)).toBe(true)` (or `expect(src).toSatisfy`) instead of `expect(src).toMatch(module export)` | Meta pin **FA-F42-R1-015-001-001-002-002**: exactly one `expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)` with TypeChecker resolve; forbids `toSatisfy` and `.test`/`toBe` guard bypasses; comment-stripped code must still contain the tempered identifier; dedicated fixture test |
| **MaliasOutside** — vacuous `toMatch(VACUOUS_…)` (or alias) with comment naming `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` | Same pin as **MtoSatisfy**; AST forbids `VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` in helper; dedicated fixture test |
| **M4CommentOnly** — M4 `it` delegates only in a comment while inlining vacuous `expect(src).toMatch` | `metaPinM4TestUsesSharedHelper`: AST requires one `assertF42DeletionE2EAfterAllWiring` call and no inline `expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)`; fixture in **FA-F42-R1-015-001-001-002-002** |
| **MtrySwallow** — wrap the module-guard `expect(src).toMatch` in try/catch so failures are swallowed while the CallExpression pin still matches | Meta pin **FA-F42-R1-015-001-001-002-002-002**: live top-level helper-body statement + no try/catch ancestor; fixture **MtrySwallow** |
| **MdeadIf** — place the module-guard `toMatch` under `if (false)` or other static dead branch while keeping a matching CallExpression | Same pin as **MtrySwallow**; fixture **MdeadIf** |
| **MshortCircuitDyn** / **MlogicalOrDyn** / **MternaryDyn** — runtime `&&` / `\|\|` / `?:` wraps `expect(src).toMatch(module export)` in a helper-body statement that still contains the call | Meta pin **FA-F42-R1-015-001-001-002-002-002-002**: statement must be exactly `expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)`; fixtures in **FA-F42-R1-015-001-001-002-002-002-002** |
| **MarrowWrap** — IIFE / arrow wrapper around the module-guard `toMatch` | Same pin as **MshortCircuitDyn**; fixture **MarrowWrap** |
| **MdeferredCall** — schedule `expect(src).toMatch` inside a callback (`queueMicrotask`, etc.) | Same pin as **MshortCircuitDyn**; fixture **MdeferredCall** |

**Residual closed (ME REAUDIT_PR189):** **FA-F42-R1-015-001-001-001-001-001** — pre-#189 AST walked any nested `afterAll`, so **MdescribeSkip** survived. Guard now scans only top-level `ExpressionStatement` `afterAll` calls and requires a single matching hook body.

**Residual closed (ME REAUDIT_PR187):** **FA-F42-R1-015-001-001-002** — ledger overclaimed that reverting the production assertion to the vacuous regex would fail CI; only fixture copies of the tempered guard were exercised. Shared `assertF42DeletionE2EAfterAllWiring` wires production checks to `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD`, and a self-source meta test fails if the helper or M4 block reintroduces the vacuous pattern.

**Residual closed (ME REAUDIT_PR191):** **FA-F42-R1-015-001-001-002-001** — meta pin `toContain("AFTER_ALL_DELETE_FIRMS_UIDS_GUARD")` also matched the exported name `VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD`, so **MvacuousConstInHelper** survived. Pin now requires the tempered identifier as a whole token and forbids `VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` in the helper body; fixture test documents the old vs new pin behaviour.

**Residual closed (ME REAUDIT_PR192 / PASS 9.9):** **FA-F42-R1-015-001-001-002-001-001** — token-only meta pin still accepted a **local shadow** of `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` wired to an alt-syntax vacuous regex (`[^]*?`). Pin now uses TypeScript AST on the exported helper (`metaPinHelperUsesModuleGuard`): no inner binding of that name, and `expect(src).toMatch` must reference the identifier; forbids `\[\^]` alt-regex span and vacuous pattern literals in helper text; fixture **MshadowAltSyntax** documents the evasion.

**Residual closed (ME REAUDIT_PR193 / PASS 9.9):** **FA-F42-R1-015-001-001-002-001-001-001** — VariableDeclaration-only binding ban still allowed **MshadowParam** (parameter default shadow) and **MshadowDestructure** (object destructure binding). Pin now walks helper parameters and all binding patterns, and requires TypeChecker resolution of the `toMatch` identifier to the module-level exported `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD`; fixtures **MshadowParam** / **MshadowDestructure** document the evasions.

**Residual closed (ME REAUDIT_PR191 follow-up / PASS 9.9):** **FA-F42-R1-015-001-001-002-002** — comment / `toSatisfy` / `.test`+`toBe` evades on the meta pin and comment-only M4 delegation. Pin now requires exactly one TypeChecker-resolved `expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)`, forbids bypass expectations and vacuous identifiers in the helper AST, strips comments before the tempered-identifier code pin, and AST-checks the M4 test via `metaPinM4TestUsesSharedHelper`; fixtures **MtoSatisfy**, **MaliasOutside**, and **M4CommentOnly** document the evasions.

**Follow-up on PR #195 (ME REAUDIT_PR195):** **FA-F42-R1-015-001-001-002-002-001** — removed dead `expectSrcToMatchGuardArg` after refactor to `collectExpectSrcToMatchGuardIds` so Gates `eslint --max-warnings 0 functions` passes (no meta-pin weakening).

**Residual closed (ME REAUDIT_PR195 / PASS 9.7):** **FA-F42-R1-015-001-001-002-002-002** — CallExpression-only meta pin still accepted **MtrySwallow** (try/catch around `expect(src).toMatch`) and **MdeadIf** (`if (false)` / dead-branch placement) while TypeChecker and token pins passed. `metaPinHelperUsesModuleGuard` now requires exactly one resolved `expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)` whose containing statement is a direct child of the helper body and is not under try/catch, static-false branches, `&&` short-circuit, or ternary dead arms; fixtures **MtrySwallow** / **MdeadIf** document the evasions.

**Follow-up on PR #196 (ME REAUDIT / CI):** **FA-F42-R1-015-001-001-002-002-002-001** — live-guard pin used runtime-only `ts.isNodeDescendantOf` (not in TypeScript 5.9 public `.d.ts`) and a switch-parent narrowing that failed `tsc -p functions`. Replaced with local parent-walk descendant check; no meta-pin semantic change.

**Residual closed (ME REAUDIT_PR196 / PASS 9.8):** **FA-F42-R1-015-001-001-002-002-002-002** — live-guard pin still accepted runtime `&&`/`||`/`?:`, arrow/IIFE wrappers, and deferred callback placement while static-false try/`if`/`?:`/`&&` arms were rejected. `expectSrcToMatchGuardIsLiveTopLevelStatement` now requires the helper-body statement to be exactly `expect(src).toMatch(module AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)` (expression statement whose expression is that call, with no intervening call/arrow/logical/ternary ancestors); fixtures **MshortCircuitDyn**, **MlogicalOrDyn**, **MternaryDyn**, **MarrowWrap**, **MdeferredCall** document the evasions.

## Focused verification

Unit guard (no emulators):

```bash
npm --prefix functions test -- test/f42-e2e-cleanup.unit.test.ts -t 'FA-F42-R1-015'
```

Emulator proof (the two affected cases; requires Auth + Firestore emulators):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r1015 \
  "npm --prefix functions test -- test/f42-retention-deletion.e2e.emu.test.ts -t 'other matters and firms are untouched|authorisation: partners only'"
```

Optional: before/after row count for documents whose `firmId` contains `f42x` and Auth `listUsers` length — as recorded in `3d306fa6` (11 rows + 1 user leaked per pair of runs on the RED baseline; stable counts on GREEN).

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
| classification | **COMPLETE** — product fix on main (`3d306fa6`); this PR adds the acceptance ledger and source guard; focused emulator run on PR branch passed both affected cases (`f42r1015-emulator-e2e.log`, exit 0) |
