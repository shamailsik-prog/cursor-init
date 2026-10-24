# F42 retention and deletion: implementation plan

Spec: `docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`. Branch `claude/remediate-f42` from
`origin/main` (99681ba). Emulators on private ports (Firestore 8697, Auth 9697, hub 4793, logging 4795, websocket
8698), project `demo-f42`.

## Files

| Path | Purpose |
| --- | --- |
| `infra/retention/inventory.json`, `infra/retention/policy.json` | R2, R3 |
| `ci_gates/check_data_inventory.py`, `ci_gates/test_check_data_inventory.py`, `ci_gates/gate_g0.sh` step 20 | R3 |
| `platform/retention/tombstone.ts` | shared tombstone shape and the row-to-matter key (both stacks) |
| `platform/p5/permissionDecision.ts` | `matter-deleted`, retention actions (R4, R6) |
| `functions/src/retention/{model,config,tombstone,ops,saga,acks,apply,watch,alert}.ts` | R4, R5, R7 to R11 |
| `functions/src/p5/permission.ts`, `functions/src/d1/matter/ops.ts`, `functions/src/p2/{worker,errors,registry,scheduled}.ts`, `functions/src/http/router.ts`, `functions/src/index.ts` | R6, R7, R11, routes, exports |
| `platform/persistence/{firestoreSpineRepositories,firmScopedList}.ts`, `platform/p5/committeeScope.ts`, `app/api/d1/reporting/route.ts` | R6 (Next), R12 |
| `firestore.rules`, `firestore.indexes.json`, `infra/deploy-manifest.json`, `infra/terraform/alerts.tf` | R13, deploy |
| `functions/test/f42-*.test.ts`, `tests/f42-tombstone-next.e2e.firestore.test.ts`, `functions/test/g2.cross-firm.test.ts` | tests |
| `docs/runbooks/retention-deletion.md`, `functions/src/p2/README.md` | runbook |
| `functions/test/f42-mutants.json`, `functions/scripts/f42-mutants.mjs` | mutation |

## Tasks

1. Spec and plan (this file). Commit.
2. RED: write the e2e and gate tests against the planned interfaces; run each on the branch before implementation and
   record the failures below (they are the main behaviour: no routes, no gate, copies remain readable).
3. Inventory, policy, gate (Python), G-0 wiring; gate tests GREEN.
4. Shared table, Functions permission and list filter, worker refusal; units GREEN.
5. Retention module: config, ops, saga, acks; deletion e2e GREEN.
6. Next repository filter, committee scope, reporting membership; Next e2e GREEN.
7. Retention job, watch, alert seam, deploy manifest, indexes, rules, G-2 entries; apply e2e GREEN.
8. Mutants (at least 12) on the tombstone check, acknowledgement completeness, legal-hold check, authorisation and the
   inventory gate.
9. Verification: typechecks, eslint, suites and neighbours, G-0, G-1, G-2, deploy contract, claim gate; RED on an
   export of `origin/main`; gitleaks; PR body.

## RED/GREEN ledger

(Filled in as tasks land; the same numbers go to the PR body.)

| Suite | RED on main (count, reason) | GREEN on branch |
| --- | --- | --- |

## Verification log

(Commands and exit codes, appended as run; full output in the evidence log.)
