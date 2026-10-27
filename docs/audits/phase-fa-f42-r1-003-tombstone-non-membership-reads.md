# FA-F42-R1-003 — Firestore tombstone on non-membership read paths

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-003** (F42 R1 follow-up, spec R23; corrects RES-1)

## Problem (RED baseline)

Before PR #133 (`d3b87dbb`), `firestore.rules` admitted several **client-SDK reads that do not depend on `matter_members`**, even after an approved deletion wrote `matter_tombstones/{matterId}`. The retention design anonymises the `matters` row (it is not purged), so RES-1’s claim that these reads “end when the saga purges them” was wrong for at least:

- A **client** reading its own `matters/{matterId}` row (matched by `clientId`, no membership).
- The **accounts** role reading `intimation_register` firm-wide (register-only; not `memberReader`).
- A **user** reading or marking read their own `notifications` row about the matter (`userId`, no membership).

The same gap affected other non-membership branches (routing queue, partner registry rows, `matterScoped` collections where membership rows were left in place only to prove the tombstone clause). **Membership-gated** reads were already ended by the approval transaction revoking every `matter_members` row; those paths are intentionally unchanged here.

Root cause: no `!exists(matter_tombstones/$(matterId))` (or equivalent) on clauses that admit readers without membership. List queries needed a separate fix: evaluating `resource.data.get('matterId', default)` once against the query would admit tombstoned rows unless `list` reads `matterId` directly and the product constrains queries (documented in rules comments).

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `3d5708a5`).

- **Helpers (`firestore.rules`):** `notDeleted(matterId)` → `!exists(.../matter_tombstones/$(matterId))`; `matterLive(matterId)` for nullable matter keys; `matterScoped(matterId)` requires `notDeleted` when `matterId` is set even if membership survived in tests.
- **Primary paths (finding):**
  - `matters/{matterId}` read: client branch adds `notDeleted(matterId)` (document id is the matter id; client reads by id, not unconstrained list).
  - `intimation_register`: accounts branch uses `matterLive` on `get`/`list`.
  - `notifications`: own-row read/update uses `matterLive` on `get`/`list`/mark-read.
- **Additional non-membership paths in the same rules pass (same helper):** `routing_queue`, `matter_parties` / `conflict_checks` partner branches, and `matterScoped` collections (`committee_outputs`, `workflow_ops_activity`, …). Legacy `committee_outputs` without `matterId` is **FA-F42-R1-002** (`legacyOutputLive`), not this finding.
- **Rejected alternative:** Relying on saga purge alone for the client matter row (row stays anonymised, not deleted).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-003; main before #133 | Client, accounts, and notification reads still succeed after tombstone while matter row remains |
| RED | RES-1 (spec §10) | “Ends when saga purges” false for anonymised `matters` row |
| GREEN | `tests/firestore.rules.f42-tombstone.test.ts` — **RP1** | Client `get` on tombstoned matter **denied**; live matter **allowed** |
| GREEN | Same file — **RP2** | Accounts `get` on tombstoned intimation row **denied**; live **allowed** |
| GREEN | Same file — **RP3** | User `get` and mark-read on notification about tombstoned matter **denied**; live **allowed** |
| GREEN | Same file — **RP7** | Member partner still **denied** on `matterScoped` rows when tombstone exists (proves tombstone, not revocation alone) |
| GREEN | Same file — **RP8**, **RP9** | Unconstrained or tombstoned-matter **list** queries **denied**; query constrained to live matter **allowed** |
| GREEN | Same file — **RP0** | Live-matter list controls for notifications and intimation register still **allowed** |
| GREEN | Membership paths | `memberReader` / `isMember` clauses unchanged; revocation at approval still ends membership-gated reads (not re-tested as regressions in this file) |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r3 \
  "npx vitest run --no-file-parallelism tests/firestore.rules.f42-tombstone.test.ts -t 'FA-F42-R1-003'"
```

Full rules suite (includes RP4 legacy committee rows for **002** in the same file):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r3 \
  "npx vitest run --no-file-parallelism tests/firestore.rules.f42-tombstone.test.ts"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (Firestore read-time tombstone on non-membership paths; broader F42 retention/deletion remains gated elsewhere) |

No COMPLETE / product-done claim.
