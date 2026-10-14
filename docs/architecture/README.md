# Architecture documents

## Where the specification lives

The governing architecture set is `SIKANDER_AI_Architecture_Set_v19.txt` in this directory (text extract; pages
are marked `=== PAGE n ===`). It is the set as amended; no session reconstructs the architecture from memory
(Layer 17 §1.4 rule 4, p. 245).

Layers and errata in the set, in order of the text: v6 master architecture; Layer 17 (Reconciliation, Completion &
Amendment No. 1); Layer 18 (Implementation Consolidation) with its errata E-15 to E-22 (§13.1, p. 319); Layer 18
Erratum Set No. 1 (p. 336); a later layer for Phase 3 research and viewer work (p. 343).

Proposed changes that are not yet signed live beside it as separate files. At present:
`ERRATUM_SET_2_PROPOSED.md` (E-23 to E-51 and open items O-15 to O-76, PROPOSED, pending the partner's
signature). A proposed set does not govern until signed. The rulings behind the Phase 1 foundation work, one line
each, are in `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md`.

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

## Running the gates and scans locally

CI is `.github/workflows/gate-g0.yml` (seven independent jobs) plus `pr-phase-claim-gate.yml`. Each command below is
what the matching CI job runs. Requirements: Node 22, Java 21+ (Firebase emulators), Python 3.12, and both installs
(`npm ci` and `npm ci --prefix functions`).

| CI job | Command (repo root) | Notes |
|---|---|---|
| lint-typecheck | `npm run typecheck` then `npm run lint` | Both must report 0. |
| unit | `npm run test:unit` | Vitest, 15 s per-test timeout. The emulator-backed files are excluded unless `FIRESTORE_EMULATOR_HOST` is set. |
| rules | `npm run test:rules` | Firestore emulator on the repo ports (18088). |
| functions | `npm --prefix functions run typecheck`, `npm --prefix functions run build`, `npm --prefix functions run test:emu` | Auth (19099) and Firestore emulators. Without emulators the suites skip locally; with `CI` set they fail instead (`functions/test/emu.ts`). |
| gates | `npm run gate:g0`, `npm run gate:g1`, `npm run gate:g2` | See below. |
| next-build | `npm run build` | `next build`. |
| postgres-ddl | `SIKANDER_POSTGRES_URL=postgres://… npm run test:postgres-ddl` | Requires Postgres 16 with the `vector` extension (CI uses `pgvector/pgvector:pg16`). CI first applies every `postgres/ddl/*.sql` twice with `psql` (idempotency); the harness then applies them all in order (`001_corpus_contract.sql`, `002_platform.sql`, `003_corpus_publication.sql`, …) and runs the trigger, grant and publication tests (PG-DDL-1..20) and the FA-DATA-001 probe regression, one file at a time (`--no-file-parallelism`). Run it against a fresh database: PG-DDL-5 and PG-DDL-10 cannot re-run on one they already ran on. |
| corpus-service | `python3.12 -m venv .venv && .venv/bin/pip install -r corpus_service/requirements-test.txt && CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://… .venv/bin/python -m pytest corpus_service/tests -q` | Node must be on the path for the dashboard harness test. Keep the venv outside the repo or ignored. The F20 trust tests and the F19 publication tests need Postgres 16 with `vector` (CI uses `pgvector/pgvector:pg16`); without the URL they skip locally, and with `CI` set the run fails instead (`corpus_service/tests/conftest.py`). The F19 tests apply the Annex A DDL (001 + 003) to each per-test database themselves; CI also applies it twice to the service database first. Verified: 175 passed, 0 skipped. |
| pr-phase-claim-gate | `PR_TITLE="…" PR_BODY="$(cat body.md)" BASE_SHA=$(git merge-base origin/main HEAD) HEAD_SHA=$(git rev-parse HEAD) python3 ci_gates/check_pr_phase_claims.py` | Checks the PR title and body against the changed files (flags, `/ops` evidence, no unqualified completion claims). |

Gates:

- **G-0 (static):** `bash ci_gates/gate_g0.sh`. Check [15], the product + phase-audit-doc guard, diffs against `BASE`
  (default `origin/main`; CI passes the pull request's base commit and checks out full history). In a shallow clone, or
  one without `origin/main`, set `BASE` to a commit you have, for example `BASE=$(git merge-base origin/main HEAD)`.
  `SIKANDER_LIVE=1` also runs the live checks when `ci_gates/gate_g0_live.sh` exists.
- **G-1 (spine):** `python3 ci_gates/gate_g1.py` runs `tests/gate_g1.test.ts` (G1-1 to G1-10), in memory.
- **G-2 (cross-firm isolation):** `npm run gate:g2`. Locally it starts the Auth and Firestore emulators on ephemeral
  ports with a private `demo-g2-*` project, so it can run beside other emulators. With `CI` set it uses the repo
  ports and `demo-sikander`. Set `G2_EVIDENCE_OUT=path.json` to keep the evidence used by `recordGatePass` (E-36).

Ports: `test:rules` and `test:emu` use the ports in the repo `firebase.json`. If another checkout's emulators hold
them, do not edit `firebase.json`: write a temporary config with free ports (`functions/README.md`, "Port notes"; for
the rules suite add `"firestore": { "rules": "<absolute repo path>/firestore.rules" }`) and run the same suites
through it, for example
`npx firebase emulators:exec --config /tmp/fb.json --only auth,firestore --project demo-local "npm --prefix functions test"`.

Workflow files: `actionlint .github/workflows/*.yml` checks syntax and expressions. Third-party actions are pinned to
commit SHAs with the tag in a trailing comment; to move a pin, take the commit for the new tag from
`git ls-remote --tags https://github.com/<owner>/<action>.git` (use the `^{}` line for an annotated tag).
