# FA-F42-R1-010 — Committee scope evicts tombstoned matter from in-process cache

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-010** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

Before PR **#133** (`d3b87dbb`), `resolveCommitteeScope` / `canAccessMatter` loaded matters through `loadMatter`, which used `repos.matters.get ?? store.matters.get`. After a matter was tombstoned in Firestore:

1. A prior route sync (for example documents GET) could leave a live `Matter` in `store.matters`.
2. The Firestore repository correctly returned `null` for the tombstoned matter (no row / filtered read).
3. `loadMatter` still fell back to the cached copy, so a direct call to `resolveCommitteeScope` (without running the route's `syncFirmMatters` first) could scope Committee Brain to a deleted matter.
4. HTTP routes that reconcile the cache first were less exposed; the platform helper itself was not fail-closed like document reads under FA-F13-039.

Root cause: in Firestore mode, repository `null` was not authoritative for matters the way it already was for documents in `resolveCommitteeScope`'s document loop.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `8028604a1b97dda3951217943bed58ad674f94f3`).

**Chosen approach:** mirror the document contract (FA-F13-039): when `resolvePersistenceMode() === "firestore"` and `repos.matters.get` returns `null`, delete the id from `store.matters` and return `null`; memory mode keeps the existing `stored ?? store.matters.get` fallback because the repository and cache are the same store.

- **`platform/p5/committeeScope.ts` — `loadMatter`:** Firestore null → `store.matters.delete(matterId)` and `return null` (FA-F42-R1-010 comment). Otherwise hydrate from repository or cache as before.
- **`platform/p5/committeeScope.ts` — `canAccessMatter`:** `!matter` → `{ allow: false, reason: "unknown-matter", matter: null }`.
- **`platform/p5/committeeScope.ts` — `resolveCommitteeScope`:** `!decision.matter` → `CommitteeScopeError` 404 `NOT_FOUND` / `unknown matter`.
- **Related (routes, not this finding's direct API):** D1 routes run `syncFirmMatters` so tombstoned matters drop out of the cache on normal HTTP paths; R1-010 closes the gap for callers that invoke scope resolution without that sync (spec **R30**).
- **Rejected alternative:** Relying only on route-level cache reconciliation (leaves library callers and race windows scoped to stale matter rows).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-010 | Cached matter used when repository returns null after tombstone |
| RED | `platform/p5/committeeScope.ts` before #133 | `const matter = stored ?? store.matters.get(matterId)` with no Firestore eviction |
| GREEN | `platform/p5/committeeScope.ts` — `loadMatter` | Firestore + `stored === null` → cache delete + null |
| GREEN | `tests/f42-r1-followup-next.e2e.firestore.test.ts` — `FA-F42-R1-010` | Warm cache via documents GET; control resolves scope; after tombstone: 404 `unknown matter`, `store.matters.has(deleted)` false, with and without `documentIds`; live matter still resolves |
| GREEN | `tests/p5.committeeScope.test.ts` — `resolveCommitteeScope` / `canAccessMatter` | Unknown matter → 404 / `unknown-matter` (unit path without Firestore emulator) |
| GREEN | Spec R30 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | R1-010 committee scope trusts repository null in Firestore mode |

## Focused verification

```bash
npm test -- --run tests/p5.committeeScope.test.ts
```

With Auth + Firestore emulators (same harness as other F42 R1 follow-up Next tests):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r1next \
  "npm test -- --run tests/f42-r1-followup-next.e2e.firestore.test.ts -t 'FA-F42-R1-010'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (committee scope cache eviction acceptance for R1-010; broader F42 retention/deletion and route sync remain gated elsewhere) |

No COMPLETE / product-done claim.
