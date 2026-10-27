# FA-F42-R1-008 — Data inventory scanner (G-0 step 22 / spec R28)

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-008** (F42 R1 follow-up, spec R28; was G-0 [22])

## Problem (RED baseline)

At main **`301e65d`** (independent re-audit on branch `claude/remediate-f42-fu`, before PR **#133**), `ci_gates/check_data_inventory.py` missed **21 of 33** auditor-planted stores that matched how this codebase actually names data:

- Template literals and `+` concatenation (including constants not named `*COLLECTION`)
- camelCase collection ids
- Modular `collection()` / `collectionGroup()` and `doc(handle, collection, …)`
- `.js` / `.cjs` under `functions/` and `scripts/`
- `components/` paths outside the old scan roots
- Postgres DDL outside `postgres/ddl`, SQL inside Python strings, and qualified schemas (`client_private.judgment`, etc.)

The gate also treated **`firestore.rules` as sufficient** for many collections: **55** inventoried Firestore stores were reachable only through rules paths, while a **server-only** collection (rules block with `allow read, write: if false`) still needs a code-visible name — rules alone must not satisfy coverage for an inventoried server-only store.

Root cause: a narrow static scan (limited paths, literal-only collection arguments, `*COLLECTION*` constant naming, and rules-heavy coverage) with no emulator cross-check.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further scanner behaviour change on top of `439fff3d`).

**Chosen approach:** whole-tree static resolution (string, template, any constant, concatenation, modular SDK calls, Python/SQL surfaces) plus a run-time `listCollectionIds` comparison when the gate runs with `--runtime` inside `firebase emulators:exec` after the Functions suite (`ci_gates/check_data_inventory.py` module doc and `list_emulator_collections`).

- **`ci_gates/check_data_inventory.py`:** Scans every non-excluded source suffix (`.ts`, `.tsx`, `.js`, `.cjs`, `.py`, `.sql`, …) under the repo; resolves collection arguments; flags dynamic prefixes that match no inventoried collection; fails server-only inventoried collections found **only** in `firestore.rules`; covers object prefixes, Postgres relations (including non-`public` schemas), policy/inventory shape checks; optional `--runtime` compares emulator root collection ids to `infra/retention/inventory.json` (fixture allow-list `RUNTIME_TEST_COLLECTIONS`).
- **`ci_gates/test_check_data_inventory.py`:** `AUDITOR_PLANTS` — exactly **33** must-fail shapes; `AuditorPlants` proves each plant fails and names the store; `test_a_server_only_collection_must_be_visible_in_code` and `test_a_dynamic_name_must_begin_an_inventoried_collection`; `RuntimeCheck` pins `check_runtime_collections` for uninventoried emulator roots.
- **G-0 wiring:** `ci_gates/gate_g0.sh` step **[22]** runs the gate and the unit file; `tests/g0-gate-e2e.test.ts` documents check [22] and FA-F42-R1-008 fixture paths for the minimal G-0 tree.
- **Rejected alternative (finding text):** Relying on rules-only discovery or a one-off `listCollections` without inventory comparison (does not ratify classification/key/profile); full TypeScript AST constant propagation was deferred in favour of the regex + export-resolution scan that already catches the 33 plants.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-008; re-audit at `301e65d` | 21/33 planted stores missed; rules-only coverage for dozens of collections; server-only store not required in code |
| RED | `docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md` §11 / **R28** | Describes the gap class (templates, camelCase, modular SDK, whole tree, runtime list) |
| GREEN | `ci_gates/test_check_data_inventory.py` — `AuditorPlants` (`len(AUDITOR_PLANTS) == 33`) | Every plant fails `check_data_inventory` and the finding message names the store; clean tree passes |
| GREEN | Same file — `test_a_server_only_collection_must_be_visible_in_code` | Rules-only server-only collection fails; naming via any constant in code passes |
| GREEN | Same file — `RuntimeCheck` | Uninventoried root `zz_unknown_store` fails with run-time message; inventoried roots pass |
| GREEN | `python3 ci_gates/check_data_inventory.py` on shipped tree | PASS (all stores covered; no stale entries) |
| GREEN | `ci_gates/gate_g0.sh` step [22] | Static gate + unit file run in G-0 CI |
| GREEN | Spec **R28** (design) | Scanner + runtime check behaviour marked corrected |

## Focused verification

```bash
python3 ci_gates/test_check_data_inventory.py -v

python3 ci_gates/check_data_inventory.py
```

To exercise the emulator `listCollectionIds` path locally (after Functions tests have populated the emulator):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test && python3 ci_gates/check_data_inventory.py --runtime"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (inventory scanner acceptance for R1-008; broader F42 retention/deletion and full emulator runtime wiring in CI remain gated elsewhere) |

No COMPLETE / product-done claim.
