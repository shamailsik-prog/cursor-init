# Architecture documents

## Where the specification lives

The governing architecture set is `SIKANDER_AI_Architecture_Set_v19.txt` in this directory (text extract; pages
are marked `=== PAGE n ===`). It is the set as amended; no session reconstructs the architecture from memory
(Layer 17 §1.4 rule 4, p. 245).

Layers and errata in the set, in order of the text: v6 master architecture; Layer 17 (Reconciliation, Completion &
Amendment No. 1); Layer 18 (Implementation Consolidation) with its errata E-15 to E-22 (§13.1, p. 319); Layer 18
Erratum Set No. 1 (p. 336); a later layer for Phase 3 research and viewer work (p. 343).

Proposed changes that are not yet signed live beside it as separate files. At present:
`ERRATUM_SET_2_PROPOSED.md` (E-23 to E-26, PROPOSED, pending the partner's signature). A proposed set does not
govern until signed.

## Precedence

Layer 18 Erratum Set No. 1 > Layer 18 > Layer 17 > earlier text, where they conflict (stated on p. 343 of the
extract, line 9425). Between Layer 17 and Layer 18: Layer 17 governs scope and rules; Layer 18 governs
implementation form (Layer 18 §0.2, p. 287, line 7787). Where an erratum set and the layer it is bound behind
differ, the erratum set governs (Erratum Set No. 1, status line, p. 336). An erratum set once signed is taken to rank above
the erratum sets before it. That last ordering is inferred from Set No. 1's status line (p. 336); it is not stated in the set,
and the partner is to confirm it at signature. The Phase 3 layer (p. 343) ranks below Erratum Set No. 1.

## How a new numbered layer or erratum is added (Layer 17 §1.4, p. 245, lines 6692–6699)

1. The set is amended only by a numbered layer (L18, L19 ...) or a numbered erratum (E-n) bound behind the
   governing document, each dated and each stating what it overrides.
2. Locked v6 text is never edited. It is overridden by erratum, so that a reader can see what was decided and what
   was changed.
3. A gap analysis from any model or person is triaged into three bins before anything is adopted: genuinely new;
   already present under another name; excluded by design. Only the first bin may become a layer.
4. Every session opens from the set as amended.
5. Nothing in an amendment may reopen an item in the exclusion register (§5) without an express, recorded
   reversal of the decision that excluded it.

In practice, for this repository:

- Write the erratum in the set's format: No. / Where / Change / Authority, with the Where column citing page and
  line of the extract. Number it from the last erratum in use (E-22 in Layer 18 §13.1; E-23 onward is in the
  proposed Set No. 2).
- Mark it PROPOSED until the partner (Advocate Shamail Sikander) signs. Include a signature and date block.
- Code features are governed separately by Layer 18 §9 (Amendment Layer Protocol, p. 307): a new feature needs both
  a layer folder under `/layers` behind a feature flag and a numbered layer in the set.
- Once signed, append the text to the set file and update the precedence line above.

## Frozen layers

Code with no basis in the set is frozen behind a feature flag rather than deleted (Layer 18 §9.1 rule 4; proposed
Erratum E-24). Frozen means the routes answer `404 { "error": "feature_disabled", "flag": "<FLAG>" }` while the flag
is off, after authentication (an anonymous caller still gets 401) and with a `feature_disabled` audit entry (at most
one per user, route and flag per minute); the
handlers, collections and stored records are untouched and come back when the flag is turned on. The registry,
with owner, spec reference and default for each flag, is `FLAG_REGISTRY` in `platform/flags/featureFlags.ts`
(a subset of the `feature_flags` seed in `postgres/ddl/002_platform.sql`, checked by test); the route gate is `platform/flags/routeGate.ts`.

| Flag | Default | Freezes | Stays live |
|---|---|---|---|
| `LEGACY_GOVERNANCE_CHAINS` | off | Every view and action of `/api/d2/ops-reporting` (the governance / attestation / adjudication / seal-verification / lattice chains). Every view and action of `/api/d4/filings` outside the core: dispatch queue, annexures, submission receipts / reconciliation / exceptions, transport execution, escalation, closure and settlement chains. | `/api/d4/filings` POST `create_package` (citation gate, `partnerOverride`) and `decide_package` (partner approval; with the flag off an approval stops at filing readiness and writes no dispatch-queue or annexure row), and GET of the package list (no `view`, or `view=packages`). |

Re-enabling:

- **Deployment:** set `SIKANDER_FLAG_LEGACY_GOVERNANCE_CHAINS=true` (`false` or unset keeps the default). Turning it
  on in production needs a further erratum and the partner's decision (E-24, ES2-3). The per-firm override
  (`firm_feature_overrides`) is reserved and not yet read.
- **Tests:** the test files that exercise the frozen chains are listed in `LEGACY_CHAIN_TEST_FILES` in
  `tests/setup/legacy-chains.ts` (a Vitest setup file), which turns the flag on for those files only. Add a file
  there only if it tests frozen code. Every other file sees the default; `tests/boot.all-layers-disabled.test.ts`
  checks that the core boots and answers with every non-core flag off, and that the frozen routes answer
  `feature_disabled`.
- **`/ops` console:** a step that reaches a frozen route shows "<step>: disabled (LEGACY_GOVERNANCE_CHAINS is off)"
  as a notice instead of failing.
