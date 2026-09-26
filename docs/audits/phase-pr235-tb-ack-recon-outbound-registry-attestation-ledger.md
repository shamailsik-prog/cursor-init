# Independent Phase Auditor A–F audit: PR #235 TB ack-recon outbound-registry attestation ledger

> **Verdict (2026-09-26): FAIL — 0 blockers, 1 major, 0 new minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: #235 (closed / squash-landed)  
Audited landed tip: `93cb5c0d10ad0028e0f7aa31e3029bbc28619cd0`  
Parent before land: `a0f73c286f3f180f3af380696273b8fd8c55b2ab`

## Executive finding

**Lattice-integrity finding: FAIL (major).** The squash did not truncate the
files: `route.ts` grew from 33,182 to 33,798 lines and the `/ops` source still
contains GET steps 485–494. However, the public GET 492 parent view is
semantically replaced by GET 494 in `parseView`. The console still issues its
declared GET 492 request, but the parser returns the 494 child view and the
route lists child rows. This breaks the required 491/492 parent chain
end-to-end, so source presence and the passing grep-oriented tests are not
sufficient for acceptance.

## Verified labels and product classification

| Claim | Independent result |
|---|---|
| `backend_real=true` | PARTIAL — 493/494 handlers, governance builders, memory/Firestore repositories, and rules are present; the required 492 parent GET contract is broken by route parsing. |
| `frontend_real=true` | **FAIL** — the `/ops` call site is concrete, but its 492 request does not render/list the requested parent surface. |
| `transport_stub=true` | PASS — `transport_stub:true` and `blocked_todo_firm` are explicit and fail-closed. |
| `classification=PARTIAL` | PASS — transport stubbing correctly precludes COMPLETE; no live court transport credentials are required. |

## A. Scope, acceptance, and merge lattice integrity — FAIL (major)

- Git confirms the audited tip is `93cb5c0` with direct parent `a0f73c2`.
  `route.ts` is exactly **33,182 → 33,798** lines; its diff is 618 lines
  (617 additions, one deletion). `operator-audit-console.tsx` is
  **4,629 → 4,755** lines.
- The executable console lattice retains source steps 485, 486, 487, 488, 489,
  490, 491, 492, 493, and 494. GET 493/494 appear after the 491/492 lifecycle,
  and the new block has six concrete POST calls to `/api/d2/ops-reporting`.
- This physical preservation is not functional parent preservation. The 492
  view string is accepted only by a `parseView` branch that maps it to the 494
  child string. No preceding `return value` branch accepts the original 492
  string. Consequently the 492 console query reaches the 494 route branch.

**Required fix:** keep the existing 492 view string as `return value`, remove
the parent-to-child remap, and add a route assertion proving a 492 query returns
the parent row/status rather than a 494 row. Retain distinct exact-value branches
for 493 and 494.

## B. Architecture and `backend_real` — PARTIAL

- The new 493/494 POST handlers validate finalized/attested parent prerequisites,
  build rows, persist through repository adapters, write audit records, and
  maintain idempotency.
- The #233 remediation remains intact: the deny-by-default Firestore binder
  maps both parent and child workflow-ops keys and factory construction is
  exercised by the emulator suite.
- The broken 492 parser contract means the stated “on 491/492 parents”
  architecture cannot be accepted end-to-end. The defect is introduced by this
  landed PR and is not the inherited #205 persistence minor.

## C. `frontend_real` — FAIL (major)

- `readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice`
  has concrete GET `/api/d2/ops-reporting` call sites for 491/492 and 493/494,
  followed by **6/6** POST call sites for the new slice.
- GET 491, 493, and 494 are covered by repository route-wiring tests and pass.
  The test suite does not assert GET 492’s returned parent shape/status.
- The console’s 492 request supplies the parent `partner_handoff_attestations`
  view. `parseView` converts it to
  `partner_handoff_attestations_outbound_registry_attestation_ledgers`; this is
  494, not 492. Therefore the claimed parent UI surface is API-call scaffolding
  with incorrect runtime semantics, not a valid frontend-real completion.

## D. Data, Firestore, security, and governance honesty — PASS

- `npm run test:rules` passes **22/22**: Firestore rules 7, repository adapter
  1, and runtime persistence mode 14.
- The deny-by-default binder explicitly maps parent and new child collections;
  server repositories provide `upsert`, `get`, `listByFirm`, and `listByMatter`.
- Governance records retain `transport_stub:true`, use the
  `blocked_todo_firm` external channel, and do not add external court transport
  credentials. Client write denial and same-firm/classification protections stay
  covered by the emulator rules tests.

## E. Tests and gates — FAIL overall

| Command | Independent result |
|---|---|
| `npx vitest run tests/ops.pr-tb-ack-recon-outbound-registry-attestation-ledger-493-494-frontend-real.test.ts tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts` | PASS — 3 files, **133/133** |
| `npm run test:rules` | PASS — 3 files, **22/22** |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | PASS — **10/10** |
| Exact closed-PR #235 metadata replay through `check_pr_phase_claims.py` | PASS |

The focused tests prove the source call sites and 491/493/494 repository
responses, but they omit the 492 parent-response regression. The claim gate
correctly validates metadata format; it does not prove parser semantics.

## F. Docs, labels, and regressions — FAIL due to major

- The closed PR body correctly supplies all three labels, `classification=PARTIAL`,
  `/ops` action-to-call-site evidence, a focused `tests/ops*.test.ts`, and the
  concrete `/api/d2/ops-reporting` path. Its exact metadata replay passes with
  `BASE_SHA=a0f73c2...` and `HEAD_SHA=93cb5c0...`.
- The labels are nevertheless overbroad at the landed tip: source-level
  `frontend_real=true` is contradicted by the 492 → 494 remap. The accepted
  terminal Product classification remains PARTIAL solely because
  `transport_stub=true`.

## Final classification

**Phase audit: FAIL (0 blockers, 1 major, 0 new minors). Product: PARTIAL.**

The merge is physically complete, not truncated. Its critical defect is
functional lattice damage: GET 492 has been remapped to GET 494. Restore the
492 parser identity and add returned-row assertions for all four surfaces
491–494 before a re-audit.

---

## Independent re-audit after remediation PR #237 (2026-09-26)

> **Verdict (corrected): FAIL phase audit — 0 blockers, 1 major, 0 new minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Remediation PR: #237 (squash-landed; partial fix only)  
Audited tip (`origin/main`): `f22c9d5c0250bf0d64a27d5c582af942814f4a5e`  
Claim-gate replay parent (#236 docs landing): `cca311031c2d3127e286b4c35f18dea5c652d9c4`  
Original #235 landed tip: `93cb5c0d10ad0028e0f7aa31e3029bbc28619cd0`  
Pre-#235 parent: `a0f73c286f3f180f3af380696273b8fd8c55b2ab`

Full SHAs verified with `git rev-parse`.

### Prior major status

| Defect | Introduced | Status at `f22c9d5` |
|---|---|---|
| GET **492** parent view remapped to GET **494** child in `parseView` | #235 (`93cb5c0`) | **Closed** by #237 (identity branch; 492→494 remap removed) |
| GET **491** parent view remapped to GET **493** child in `parseView` | #235 (`93cb5c0`) | **Open (major)** — remap source remains at `route.ts` ~784–785 |

### 1. Evidence: no 491→493 remap before #235 (`a0f73c2`)

Independent checks on `a0f73c286f3f180f3af380696273b8fd8c55b2ab`:

- The GET **493** child view suffix
  `…_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers`
  is **absent** from `app/api/d2/ops-reporting/route.ts`.
- `parseView` contains **zero** non-identity `return "alert_…"` remaps.
- The `/ops` GET **491** parent view string (`…_external_distribution_audit_ledgers`)
  is accepted with `return value` only (identity).

#235 (`93cb5c0`) introduced both the **493** view string and paired parent→child
`parseView` remaps (**491→493** and **492→494**). This is not pre-existing
behaviour.

### 2. `parseView` at tip — same bug class as the original 492 major

At `f22c9d5`, `parseView` still contains a parent→child remap for the `/ops` GET
**491** query string at `app/api/d2/ops-reporting/route.ts` **lines 784–785**: the
`if (value === "…_external_distribution_audit_ledgers")` branch returns the GET
**493** child suffix
`…_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers`
instead of `return value`.

#237 added an earlier `return value` branch for the same **491** string (shadowing
in execution order) but **did not remove** this remap block. The lattice still
documents and ships a parent→child substitution for **491→493**; #237 fixed only
the **492→494** pair.

**CM #237 inaccuracy:** The claim that the **491→493** remap is “now-dead behind
an identity branch” is not an acceptable remediation for phase audit. The remap
remains the only live non-identity `return` in `parseView`; shadowing does not
remove the defect class (duplicate/conflicting branches; `/ops` **491** still
declares a parent GET while the route retains an explicit parent→child remap).

At **`93cb5c0`**, the **491** parent query hit this remap directly (no preceding
identity branch for the same string). At **`f22c9d5`**, **492** is restored to
identity; **491→493** remap source is unchanged aside from shadowing.

### 3. `parseView` table (console-wired GET 485–494)

| GET | `parseView` outcome at `f22c9d5` |
|---:|---|
| 485–490 | Identity |
| 491 | **Parent→child remap to GET 493** (major; source ~784–785) |
| 492 | Identity (**#237** fix) |
| 493–494 | Identity |

### 4. Lattice integrity (physical)

- `route.ts`: **33,798** lines; GET **485–494** ordering and six POST lifecycle
  actions for **493/494** remain present (not truncated).

### 5. Regression tests — gap that hid both remaps

- #237 added strong GET **492** assertions (`json.view` parent + status field).
- GET **491** route-wiring coverage at ~6214–6227 asserts **HTTP 200** and a
  status field on `items[0]` only; it does **not** assert
  `json.view ===` the requested GET **491** parent view. That is why neither
  **491→493** nor **492→494** was caught before the independent audit.
- Focused suite at tip still passes (**137/137**) while the **491** major
  remains.

### 6. Gates (tip)

| Command | Result |
|---|---|
| Focused FE/API/route | **137/137** |
| `npm run test:rules` | **22/22** |
| `npm run gate:g0` / `gate:g1` | PASS / **10/10** |
| #237 claim-gate replay | PASS (metadata hygiene; does not prove `parseView` semantics) |
| `pr-phase-claim-gate.test.ts` | **20/20** |

### 7. `frontend_real` / transport / #205 minor

- `/ops` call sites for **491–494** are concrete, but GET **491** remains
  **frontend_real FAIL** under the same parent-surface rule as the original **492**
  major (parent GET declared; route retains **491→493** remap).
- `transport_stub=true` stays honest → **Product: PARTIAL** only.
- Inherited #205 persistence minor: non-blocking; not newly regressed.

### Re-audit classification (final)

**Phase audit: FAIL (0 blockers, 1 major, 0 new minors). Product: PARTIAL.**

**Major:** GET **491** parent `parseView` still remaps to GET **493** child
(introduced by #235; not present at `a0f73c2`). #237 closed the **492→494**
major only. Required fix: **491** `return value`, remove **491→493** remap, add
`json.view` regression tests for GET **491** (and keep **492** coverage).

---

## Independent re-audit after remediation PR #240 (2026-09-26, Phase Auditor re-audit #2)

> **Verdict: PASS phase audit — 0 blockers, 0 majors, 0 new minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Remediation PR: #240 (squash-landed)  
Audited product tip (`origin/main` after #240): `6b487a3e3d6a07a2edef06bda9867aad0bd861d1`  
#240 parent (pre-fix tip): `f22c9d5c0250bf0d64a27d5c582af942814f4a5e`  
Original #235 landed tip: `93cb5c0d10ad0028e0f7aa31e3029bbc28619cd0`  
Pre-#235 parent: `a0f73c286f3f180f3af380696273b8fd8c55b2ab`  
Docs audit anchor (this re-audit PR): `0f27bc1403095bd84e4d7bfca811e790a5cc7c93`

Full SHAs verified with `git rev-parse` and `git cat-file -t`.

### 1. `parseView` — full function body read (not grep-only)

Independent read of `app/api/d2/ops-reporting/route.ts` **lines 525–792** at tip
`6b487a3` (post-#240). The function contains **only**:

- Null/`"activity"` coalescence → literal `"activity"` (identity for activity).
- **75** exact-string `if (value === "alert_…")` branches, each **`return value`**.
- Final **`return undefined`** (unrecognized view).

There are **no** ternaries, `.replace`, suffix concatenation, map lookups, or
`return "alert_…"` literals that differ from the matched `value`. Grep for
`return "alert_` inside `parseView` finds **zero** non-identity alert remaps
after #240 (only the `"activity"` literal on the null/activity line).

**Other view normalization:** `GET` uses `parseView(url.searchParams.get("view"))`
at ~8503 only. No `normalizeView`, alias table, or secondary remap runs before
the `if (view === "alert_…")` dispatch ladder.

#### `parseView` table — console-wired GET 485–494 at `6b487a3`

| GET | Requested view (suffix tail) | `parseView` outcome | Class |
|---:|---|---|---|
| 485 | `…_transport_boundary_receipt_reconciliations` (custody TB) | Identity `return value` | OK |
| 486 | `…_transport_boundary_receipt_reconciliations` (closure TB) | Identity | OK |
| 487 | `…_external_transport_receipt_acknowledgments` (custody) | Identity | OK |
| 488 | `…_external_transport_receipt_acknowledgments` (closure) | Identity | OK |
| 489 | `…_external_transport_receipt_acknowledgment_reconciliations` (custody) | Identity | OK |
| 490 | `…_external_transport_receipt_acknowledgment_reconciliations` (closure) | Identity | OK |
| 491 | `…_external_distribution_audit_ledgers` (custody parent) | Identity | OK |
| 492 | `…_partner_handoff_attestations` (closure parent) | Identity | OK |
| 493 | `…_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers` | Identity | OK |
| 494 | `…_partner_handoff_attestations_outbound_registry_attestation_ledgers` | Identity | OK |

#### Defect history (forensic, not rubber-stamped)

| Defect | Introduced (`93cb5c0`) | Runtime at `93cb5c0` | Source at `f22c9d5` | After #240 (`6b487a3`) |
|---|---|---|---|---|
| **492→494** `parseView` remap | Yes (live `return` child string) | **Broken** — child view returned | **Closed** (#237) | Closed |
| **491→493** `parseView` remap | Yes (duplicate `if` after identity `return value`) | **Not broken** — shadowed by earlier identity branch | **Open (major)** — dead remap block remained in source | **Closed** — remap block deleted |

The prior re-audit correctly failed **source-level** parent→child remap presence at
`f22c9d5`. Forensic correction: at **`93cb5c0`**, GET **491** was already
shadowed; only GET **492** was runtime-broken before #237.

### 2. Lattice integrity (physical)

- `route.ts`: **33,795** lines at `6b487a3` (**33,798 → 33,795** in #240; remap
  deletion only).
- `/ops` `readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice`
  retains GET steps **485–494** in order (see `operator-audit-console.tsx` step
  strings at lines ~3802–4335).
- GET **493/494** block followed by **6/6** lifecycle POSTs to
  `/api/d2/ops-reporting` (three custody + three closure; steps ~4350–4428).
- No truncation of the 491/492 parent chain in source.

### 3. Tests and regression proof

- **`it.each`** `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS` covers slices
  **485–494** (`tests/persistence.route-wiring.test.ts` ~6266–6330): imports real
  `GET` from `@/app/api/d2/ops-reporting/route`, asserts `json.view ===`
  `searchParams.get("view")`.
- **`/ops` GET 491** parent string asserted in
  `tests/ops.pr-tb-ack-recon-external-distribution-audit-ledger-frontend-real.test.ts`
  (~76–86): `GET_VIEW_491_PARENT` ends with
  `…_external_distribution_audit_ledgers`, not the **493** child suffix.
- **Would fail on old `parseView`:** with tip tests and `route.ts` checked out to
  **`93cb5c0`**, slice **492** fails (`json.view` child suffix); slice **491**
  passes (shadowing). With **`f22c9d5`** `route.ts`, slice **491** still passes
  (shadowing); #240’s value is **removing** the dead remap so the suite would
  catch a reintroduced live **491→493** mapping.

### 4. Gates (independent replay at audit anchor `0f27bc1` / product `6b487a3`)

| Command | Result |
|---|---|
| Focused FE/API/route (4 files incl. `/ops` slice tests) | **148/148** |
| Narrow trio (493–494 FE + route-wiring + api.ops-reporting) | **144/144** |
| `npm run test:rules` | **22/22** |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | **10/10** |
| `check_pr_phase_claims.py` (#240, `BASE_SHA=f22c9d5`, `HEAD_SHA=6b487a3`, PR #240 body) | PASS |
| `tests/pr-phase-claim-gate.test.ts` | **20/20** (Vitest worker timeout warning only) |

Evidence log: `/opt/cursor/artifacts/pr235_reaudit2_verification.log`.

### 5. `frontend_real` / `backend_real` / transport / #205

- **`frontend_real`:** **PASS** — `/ops` GET **491–494** use concrete
  `runApiCall` → `/api/d2/ops-reporting` with parent/child view constants; six
  POST call sites for **493/494**; `blocked_todo_firm` transport probes (no live
  credentials).
- **`backend_real`:** **PASS** (backend-scoped) — handlers, repos, rules, and
  identity `parseView` contract at tip; not COMPLETE while transport stubs remain.
- **`transport_stub=true`:** honest → **Product: PARTIAL** cap enforced.
- Inherited **#205** `persistence.repositories` minor: non-blocking; **22/22**
  emulator suite green; not newly regressed.

### Re-audit classification (final)

**Phase audit: PASS (0 blockers, 0 majors, 0 new minors). Product: PARTIAL.**

#240 closes the last **parseView** parent→child remap defect class for PR #235.
PR #235 lattice (**485–494** + six POSTs) is physically and semantically intact at
`6b487a3`. COMPLETE/product-done remains invalid while `transport_stub=true`.
