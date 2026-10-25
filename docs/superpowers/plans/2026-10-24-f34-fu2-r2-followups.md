# F34 round-2 follow-ups (FA-F34-R2-001 to -007): plan and RED/GREEN ledger

Spec: `docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md`, section 6 (R29 to R41; R26 to R28 are PR #130's at head 16f6316).
Branch: `claude/remediate-f34-fu2`, from `origin/main` 798cf56. Method: Superpowers (test-driven development, systematic
debugging, verification before completion). The owner's standing autonomy instruction applies: every decision is a ruling
in the spec with its reason.

## Tasks

1. **RED fixtures for [21]** (`tests/f34-p1-transport-import-gate.test.ts`): the auditor's plants from
   `reaudit-f34-r2/tools/gate_plants.py` as must-fail cases with the report each must name; the X15/X18/X20/X21 killers;
   the F05 and literal must-pass cases; the tightened grants and the key-name and host grants in `--print-grants`.
   Run against main's gate: each bypass passes there.
2. **The lexer** (`ci_gates/js_lexer.py`, R31): comments, decoded identifiers and strings, templates, regular
   expressions; pure Python.
3. **The gate** (`ci_gates/check_p1_transport_imports.py`): token-based import parsing; the tsconfig resolver (R29); the
   unscanned-tree rule (R30); the Gateway URLs, key names and host (R32); the loader rules (R33); the granted-file rule
   (R34); tight grants and unused-grant failures (R35). The repository must pass.
4. **The consumer** (`functions/src/cli/committeeEval.ts`): build the transport in a local const (R34).
5. **G-0 end to end** (`tests/g0-gate-e2e.test.ts`): B01, B16, B09 through `gate_g0.sh`.
6. **R37** (`gateway.ts`, `decisionRecord.ts`, `traceExport.ts`): the withholding time, its removal at publication, the
   reconciler's pass; RED e2e through `committeeBrain` and the scheduled handler (`functions/test/f34-fu2.e2e.emu.test.ts`).
7. **R38, R39**: X03/X04 e2e, X14/X25 units, the golden set per `RedactionKind` with `REDACTION_KINDS`.
8. **R40**: the stale spec text.
9. **Verification**: the auditor's `gate_plants.py` and `bundle_probe.mjs` (B01, B09, B16) on the branch; at least 15
   builder mutants plus the auditor's survivors; the Functions suite as CI runs it; G-0, G-1, G-2; G-4 Phase 3d; the deploy
   contract and `render --check`; the root F34 and F18 suites; typechecks; eslint.

## RED/GREEN ledger

RED is main 798cf56 with this branch's test files copied in (`git archive 798cf56`, the same `node_modules`); GREEN is this
branch. Counts are tests, from the runs in the evidence log.

| Suite | RED on main | GREEN on branch |
|---|---|---|
| `tests/f34-p1-transport-import-gate.test.ts` | 56 failed, 58 passed (114) | 114 passed |
| `tests/g0-gate-e2e.test.ts` | 3 failed (B01, B16, B09), 26 passed (29) | 29 passed |
| `functions/test/f34-fu2.e2e.emu.test.ts` | 2 failed (the R37 TTL case; the reconciled record's time), 4 passed (6) | 6 passed |
| `functions/test/f34-decision-units.test.ts` + `p1.units.test.ts` | 7 failed (R37 units ×3, the golden set, three `f34.3` expectations), 63 passed (70) | 70 passed |

The tests that pass on main are either mutant killers (X03, X04, X14, X15, X18, X20 ×2, X21, X25: the code was right, the
test was missing), guards of behaviour that must not change (the published, rank-1 and commit-failed R37 cases), or
must-pass fixtures.
