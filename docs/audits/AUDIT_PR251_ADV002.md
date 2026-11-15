# AUDIT_PR251_ADV002 — fix-forward of PR #251

Independent audit of `552a350f` scored 5/10 (HIGH-RISK, bar 9). This file records what that audit kept, what the fix-forward changed, and the required CI conclusions on the frozen head.

## Kept (verified on the audit SHA, unchanged here)

- 15 allowlist rows removed, 0 added. `docs/audits/known-advisories.md` has no data rows.
- No person is named as owner or approver. No review-by date was extended.
- npm audit is 0 high / 0 critical in all four scopes (root and `functions/`, full tree and `--omit=dev`).
- pip-audit was 0. Corpus Python lockfiles were not touched.
- `node ci_gates/check_known_advisories.mjs` PASS.

## ADV251-CI-001

### Gates G-0 / G-1 / G-2 (G-4 name filters)

Vitest 5 matches `-t` against the full name joined by ` > `. The G-4 scripts anchored `^suite test$`, so steps 2b-a, 3a, 3b, 3c, 3d and 4a selected 0 tests. Vitest still exits 0 in that case. The JSON reporter's `fullName` is still space-joined, so the expected-name check stays in that form.

`ci_gates/vitest5_name.mjs` reads the `describe` / `it` titles (including `describe.each` `%s` rows) and builds the anchored ` > ` regex. `ci_gates/check_vitest_json_selection.mjs` exits 1 when every collected test is skipped (`FAIL: the name pattern selected 0 tests`).

Proof (`tests/g4-vitest5-name-filter.test.ts`, Vitest 5.1.0): a space-joined anchor on `functions/test/d4.boot.test.ts` selects 0 tests and the checker exits 1; the pattern emitted by `gate_g4_phase4a.sh --filter-only` contains ` > ` and selects the named boot test (checker exit 0). All six gate scripts resolve their name lists (`--filter-only` exit 0).

### Mutation floor (document vault)

`@stryker-mutator/core` and `@stryker-mutator/vitest-runner` are pinned to 10.1.1 at the root and in `functions/`. 10.1.1 joins test names with ` > ` when Vitest is 5 or newer (10.0.0 joined with a space, so covered mutants were scored survived).

Local `npm run mutation:documents` on this tree: 851 mutants, 803 killed, 4 timed out, 33 survived, 11 no coverage. **94.83%**, break 85, exit 0. That is the score recorded for main in `docs/audits/mutation-report.md` (803 / 4 / 33 / 11). The red run on `552a350f` was 5.41% (46 killed, 794 survived).

### Cloud Functions

`functions/test/p5.identity.test.ts` spied `Transaction.prototype.get`, `logger.error` and `setCustomUserClaims` in the commit-lock-order test and never restored them. Vitest 5's `spyOn` on an existing spy keeps the same mock, so the later "users-doc transaction fails" spy observed the accumulated `setCustomUserClaims` calls (18). Those three spies are now `mockRestore`d in `finally`. The assertion `expect(setClaims).not.toHaveBeenCalled()` is unchanged.

`clearMocks: false` was removed from the root, `functions/` and `ops/backup` Vitest configs (ADV251-MOCK-002). Call history follows the Vitest 5 default (cleared before each test). No P5 assertion was weakened.

Emulator suite after that restore: 2959 passed, 1 failed, 1 skipped. The failure was not P5. `FA-F42-R1-006-003-001-002` saw `independentPartner` `undefined` because `backfillLegacyPartnerIndependencePage` reads the first 500 partners by document id, and the suite had already created more than 500. The legacy partner's id now sorts first (`\u0001` prefix) so that one page includes it. Both `toBe(false)` and `toBe(true)` assertions are unchanged. Re-run of that test under the emulators: 1 passed.

## ADV251-MOCK-002

The `clearMocks: false` shim is gone. Root `npm run test:unit` after the removal: 6730 passed, 59 skipped, exit 0 (includes the #246 P6 tests from `2e0bb009`). P6 file `tests/p6.g3.test.ts`: 19 passed.

## LOW-004 — `@types/node` in the production closure

Not pinned back. The root devDependency moved `^20` to `^22` because Vitest 5's optional peer is `@types/node` `^22 || >=24`. npm dedupes one copy. The locked version went from 20.19.43 to 22.20.5. `npm ls @types/node --omit=dev` shows that copy under `protobufjs` (dependency `>=13.7.0`) and also under `@types/express`, `@types/cors` and `@types/jsonwebtoken`. It is types only. Production `engines.node` is 22, which 22.20.5 describes. A global pin to 20.19.43 would miss the Vitest 5 peer. Production manifest ranges were not edited. The Stryker 10.1.1 bump changed only Stryker, its Babel instrumenter, and dev tooling (`obug`, `verkit`, `browserslist` and its data files).

`npm audit --omit=dev` on the 2026-11-15 database, same before and after the Stryker bump: root 7 moderate and 1 low; `functions/` 9 moderate and 1 low; 0 high and 0 critical in every scope.

## LOW-005 — required CI on the frozen head

Filled in after the required jobs finish on the head this file is committed with. Until that table is present, this fix-forward is not frozen.

| Job | Conclusion | Head |
| --- | --- | --- |
| (pending) | | |
