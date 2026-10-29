# FA-F42-R1-006-001-001 — Diamond (convergent) provisioning lineage

Register context: issue #30 **FA-F42-R1-006-001-001** [LOW] (residual of FA-F42-R1-006-001).

## Problem

`partnerLineageAncestors` treated any revisit of a `seen` uid as a cycle (`null` → 403 `*_lineage_unknown`). Convergent acyclic graphs (diamonds), e.g. associate hired by partner Q with `Q.createdBy = F` and later promoted by founder F (`partnerGrantedBy = F`), or two parent branches both rooted at F, incorrectly failed closed.

## Correction

In `functions/src/retention/partnerLineage.ts`:

- Skip duplicate frontier nodes already in `seen` (convergence at the same BFS layer).
- When a parent is already in `seen`, return `null` only if that parent is **not** yet in `ancestors` (true back-edge / cycle). If it is already counted as an ancestor, continue (DAG join).

Cycles (`cycle` ↔ `cycleB`) and depth overflow still fail closed.

Re-audit **M3** (frontier dedupe kept, but `parent already in seen → null`) still passes equal-layer diamond tests; **`FA-F42-R1-006-001-001-001`** pins the parent-already-seen half with `X = { createdBy: F, partnerGrantedBy: Q }`, `Q.createdBy = F`.

## Tests

| Case | Location |
| --- | --- |
| PROBE161_DIAMOND_X / Y shapes | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-006-001-001` |
| Mutant guard (join node, two roots) | same file — `FA-F42-R1-006-001-001 mutant guard` |
| Unequal-depth diamond (F before Q on frontier; kills re-audit **M3**) | same file — `FA-F42-R1-006-001-001-001` |
| P→Q→R, cycle, sibling emulator paths | existing `FA-F42-R1-006*` suite (unchanged) |

```bash
npm --prefix functions test -- --run f42-retention.units.test.ts -t 'FA-F42-R1-006'
cd .. && npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-006'"
```
