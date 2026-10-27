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
- **Quarantine manifest (audit F41):** `platform/boundaries/legacyGovernanceQuarantine.json` lists frozen monolith
  line budgets, the governance-adapter file cap, active-product import scan roots and quarantine path prefixes.
  G-0 check [23] (`ci_gates/check_legacy_governance_boundary.py`) fails when frozen code grows past those budgets
  or when an active-product route imports a quarantined governance adapter.

## Running the gates and scans locally

CI is `.github/workflows/gate-g0.yml` (twelve independent jobs and the `changes` path-gate job) plus `pr-phase-claim-gate.yml`. Each command below is
what the matching CI job runs. Requirements: **Node 22** with npm 10.9 for the mandatory path (console, Functions, gates; pinned in both manifests, audit F39; another npm
warns with `EBADDEVENGINES` and still installs the same tree, `gate:lockfiles` fails on it; `corepack npm …` runs the
pinned npm). **Node 24** is used only by the optional `eve-toolchain` job (audit F48; `scripts/eve-toolchain-check.sh`). Also Java 21+ (Firebase emulators), Python 3.12, and both installs (`npm ci` and `npm ci --prefix functions`).

| CI job | Command (repo root) | Notes |
|---|---|---|
| lint-typecheck | `npm run typecheck` then `npm run lint` | Both must report 0. |
| unit | `npm run test:unit` | Vitest, 15 s per-test timeout. The emulator-backed files are excluded unless `FIRESTORE_EMULATOR_HOST` is set. |
| rules | `npm run test:rules` | Firestore emulator on the repo ports (18088). |
| functions | `npm --prefix functions run typecheck`, `npm --prefix functions run build`, `npm --prefix functions run test:emu` | Auth (19099) and Firestore emulators. Without emulators the suites skip locally; with `CI` set they fail instead (`functions/test/emu.ts`). |
| gates | `npm run gate:g0`, `npm run gate:lockfiles`, `npm run gate:g1`, `npm run gate:g2` | See below. `gate:lockfiles` is the frozen-install guard with `--npm-ci` (audit F39). |
| next-build | `npm run build` | `next build`. Node 22. |
| eve-toolchain | `bash scripts/eve-toolchain-check.sh` | Audit F48: Node 24 only; `npm ci` and `npm run eve:info`. Production Functions/CI jobs stay on Node 22. |
| authority-f05 | `SIKANDER_POSTGRES_URL=postgres://… npm run test:f05-authority` | Audit F05: the user-flow e2e (`functions/test/f05-authority-corpus.e2e.emu.test.ts`), the corpus adapter and the O-59 parity suites. Needs Postgres 16 with `vector` (a superuser URL; each file creates and drops its own database and roles), Java for the Auth and Firestore emulators, and Python with `corpus_service/requirements-test.txt` (`SIKANDER_CORPUS_PYTHON`, default `python3`): the corpus is seeded through the publication CLI. The script sets `F05_AUTHORITY_SUITE=1`; without it `functions/vitest.config.ts` excludes these suites, and with it a missing URL fails the run. |
| authority-f05 (FA-D5-003 step) | `SIKANDER_POSTGRES_URL=postgres://… npm run test:fa-d5-003` | Audit FA-D5-003 (closes FA-D2WA-001) and FA-DATA-003: WhatsApp `/research` through `POST /api/d2/court-ops` on production persistence (Auth and Firestore emulators, F02 dispatch) against Postgres seeded by the publication CLI, and the research reader's grants, views, allowlist, row caps and timeout (`tests/fa-d5-003.*`). Same needs as authority-f05. The script sets `FA_D5_003_SUITE=1`; without it `vitest.config.ts` excludes these suites, and with it a missing URL fails the run. |
| postgres-ddl | `SIKANDER_POSTGRES_URL=postgres://… npm run test:postgres-ddl` | Requires Postgres 16 with the `vector` extension (CI uses `pgvector/pgvector:pg16`). CI first applies every `postgres/ddl/*.sql` twice with `psql` (idempotency); the harness then applies them all in order (`001_corpus_contract.sql`, `002_platform.sql`, `003_corpus_publication.sql`, `004_authority_read_views.sql`, `005_research_reader.sql`) and runs the trigger, grant, publication, authority-view and research-reader tests (PG-DDL-1..33) and the FA-DATA-001 probe regression, one file at a time (`--no-file-parallelism`). Run it against a fresh database: PG-DDL-5 and PG-DDL-10 cannot re-run on one they already ran on. |
| corpus-service | `python3.12 -m venv .venv && .venv/bin/pip install -r corpus_service/requirements-test.txt && CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://… .venv/bin/python -m pytest corpus_service/tests -q` | Node must be on the path for the dashboard harness test. Keep the venv outside the repo or ignored. The F20 trust tests and the F19 publication tests need Postgres 16 with `vector` (CI uses `pgvector/pgvector:pg16`); without the URL they skip locally, and with `CI` set the run fails instead (`corpus_service/tests/conftest.py`). The F19 tests apply the Annex A DDL (001, 003, 004 and 005, in that order) to each per-test database themselves; CI also applies it twice to the service database first. Verified: 951 passed, 0 skipped. |
| corpus-runtime | `CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://… bash corpus_service/tests/e2e/runtime_smoke.sh` | Audit F31: builds a fresh Python 3.12 venv from `corpus_service/requirements.txt` only (`PYTHON` picks the interpreter; `F31_RUNTIME_VENV` builds it at a path that must not exist yet, absolute, relative to the caller's directory or `~/...`, otherwise a temporary directory is used and removed), then runs `tests/e2e/runtime_smoke.py` inside it: the strict import contract (imports and by-name loads such as BeautifulSoup's `"lxml"`), `import scraper.models`, every scraper module and `bootstrap_harvest`, the harvester's lxml parse on synthetic pages, `python -m scraper.migrate`, `uvicorn scraper.main:app` answering `/health` with `db_connected`, and the Celery app with its Redis broker transport and result backend (no Redis server). Needs PyPI access and Postgres 16 with `vector` (a superuser URL; each run creates and drops its own database). It fails on a `requirements.txt` that does not declare every runtime import (pgvector on main before F31). |
| pr-phase-claim-gate | `PR_TITLE="…" PR_BODY="$(cat body.md)" BASE_SHA=$(git merge-base origin/main HEAD) HEAD_SHA=$(git rev-parse HEAD) python3 ci_gates/check_pr_phase_claims.py` | Checks the PR title and body against the changed files (flags, `/ops` evidence, no unqualified completion claims). |

Gates:

- **G-0 (static):** `bash ci_gates/gate_g0.sh`. Check [15], the product + phase-audit-doc guard, diffs against `BASE`
  (default `origin/main`; CI passes the pull request's base commit and checks out full history). In a shallow clone, or
  one without `origin/main`, set `BASE` to a commit you have, for example `BASE=$(git merge-base origin/main HEAD)`.
  `SIKANDER_LIVE=1` also runs the live checks when `ci_gates/gate_g0_live.sh` exists.
- **Next/eve AI egress guard (audit F18):** `python3 ci_gates/check_next_ai_egress.py` is G-0 check [19]: outside
  `functions/` (the control plane) and `corpus_service/` (the F27 lane), no JS/TS imports the `ai` SDK, an `@ai-sdk/*`
  package other than `@ai-sdk/provider` or a provider SDK, names a provider key (except `platform/p1/providerKeyGuard.ts`)
  or names a provider host, and no deploy surface (`.env*`, App Hosting, Vercel, Docker, compose, and workflow jobs that
  build, start or deploy the Next/eve service) binds a provider key. No allowlist. Any JS/TS file outside `functions/`
  (the corpus service included; root `tests/` stays outside the walker) that imports any `functions/` module other than
  the allowlist (`functions/src/p1/costTable`, `functions/src/p1/types`, and the F02 boundary
  `functions/src/http/f02RouterBoundary`, which mounts only `F02_NEXT_AUTHORITY_ROUTES`) fails the same check,
  including a vitest/jest loader with comments or a nested type argument (FA-F18-001, FA-F18-009, FA-F18-010,
  FA-F18-011, FA-F18-014). A `.envrc`, a workflow job at four-space indent, a symlinked directory, and any `model`
  under `agent/` fail it too: rule (f) uses a TypeScript AST pass (including `.mts`/`.cts`) so, when `agent/` exists,
  only `agent/agent.ts` may be the entry; it must import `defineAgent` by name from `"eve"` (no wrappers, namespace or
  member calls) and default-export `defineAgent({...})` with `model` checker-resolving to `committeeBrainLanguageModel`
  from exactly `platform/p1/committeeBrainModel`; only `agent/agent.ts` may import `defineAgent`, and only as a direct
  call callee; no bare side-effect imports, dynamic `import()` or `require()` (including `module.require` /
  `createRequire`) under `agent/`; no non-type import under `agent/` of a module that transitively reaches
  `platform/p1/committeeBrainModel` (static imports, `export … from`, string-literal dynamic loads, `index.ts` paths
  normalized like the resolver) except the canonical model import; modules with computed dynamic loads count as
  touching the canonical model; no re-export from outside `agent/`; outside `functions/`, only `agent/agent.ts` may
  load `"eve"` or call `defineAgent`; outside `functions/`, no computed `import()` / `require()` / `createRequire`
  specifiers; the `committeeBrainLanguageModel` name may appear only on `model:` in that call; under `agent/` only,
  no property/element/compound/logical writes, `delete`, `++`/`--`, or `Object`/`Reflect` mutation (including aliased
  globals) on the canonical model; no spreading/`Object.assign` from outside the file (FA-F18-002, FA-F18-015,
  FA-F18-016, FA-F18-020, FA-F18-025..043). Residual: non-`const` computed property keys on arbitrary objects;
  canonical-model mutation in files not reachable from `agent/` imports; obfuscated loaders (`require` alias,
  `module["require"]`, `eval`, `new Function` / `Function(`, `process.mainModule.require`) (FA-F18-043).
  `--print-pure-modules` prints
  `FUNCTIONS_PURE_MODULES` for the pure-import closure test (FA-F18-017).
- **Frozen-install guard (audit F39):** `python3 ci_gates/check_lockfiles.py` is G-0 check [18]: every lockfile
  matches its `package.json` (the root entry npm writes from it, every direct dependency present), npm is pinned
  (`packageManager` + `devEngines.packageManager`, `onFail: warn`, one pin for every manifest), no directory holds
  two lockfiles, the root and every directory an install surface runs `npm ci` in has one, and no workflow,
  `.cursor/environment.json`, `.claude/hooks/*` or package script installs without the lockfile. Commands are read
  with a shell lexer (a step's `working-directory` and a preceding `cd` are followed); an `npm ci` whose target it
  cannot read (a variable, a computed `cd`) fails unless `ci_gates/lockfile_install_allowlist.json` vouches for it. With `--npm-ci`
  (`npm run gate:lockfiles`, and a step in the CI gates job) it also checks that the running npm is inside the pin and
  runs `npm ci --dry-run --ignore-scripts` for each lockfile: npm's own validator, which catches an override added,
  changed or removed in `package.json` without the lock. Regenerate a lockfile only with the pinned npm
  (`npm install --package-lock-only --ignore-scripts`), never by hand.
- **Legacy-governance boundary guard (audit F41):** `python3 ci_gates/check_legacy_governance_boundary.py` is G-0
  check [23]: listed monolith/spine paths must exist; per-folder line and file caps under quarantine prefixes;
  recursive `workflowOps*Governance.ts` discovery with per-file, total-line and file-count adapter budgets; blocks
  imports of those adapters from active-product trees (`app/api/d1`, `app/api/d2/court-ops`, `app/api/d5`,
  `functions/src`); requires `LEGACY_GOVERNANCE_CHAINS` to default off. Budgets live in
  `platform/boundaries/legacyGovernanceQuarantine.json` (inventory v2, FA-F41-002). CodeQL still analyses filings,
  ops-reporting, the operator console and governance adapters; only the one adapter path that exceeds CodeQL's trap
  filename limit is excluded (`.github/codeql/codeql-config.yml`, FA-F41-001).
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
