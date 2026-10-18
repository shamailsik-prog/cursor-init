# Audits, gates and scans

What each automated check proves, where it runs, and how to run it locally.
Per-PR checks run in `.github/workflows/gate-g0.yml` (Gate G-0 job) and
`.github/workflows/security.yml`; mutation testing is weekly / on demand in
`.github/workflows/mutation.yml`. Actions minutes are billed on this private
repository, so a draft PR runs none of these checks (only the PR phase-claim
gate). They run when a PR is opened ready, marked ready for review, or pushed
to while ready, and on every push to main. On a PR, the Postgres DDL and
`corpus_service` pytest jobs run only when files they depend on changed (the
`changes` job in `gate-g0.yml`). Phase-audit write-ups (`phase-*.md`,
`lattice-*.md`) in this directory are separate records, not gates.

## Gates (per PR, `gate-g0.yml`)

| Check | Proves | Run locally |
| --- | --- | --- |
| Typecheck | The Next app type-checks (`next typegen` + root `tsc`); `tests/` and in-process Functions helpers type-check separately (`tsconfig.tests.json`, including `functions/src` via `functions/node_modules`). | `npm run typecheck` and `npm run typecheck:tests` |
| Gate G-0 (static) | Foundations hold: no court-fee identifiers, no scraper libraries, AI SDKs imported only under P1, no duplicate routes, Phase 0 files present, case-number fixtures valid, the 159 document types are not cloned, embedding dimension matches the DDL, classifications compared by rank, Firestore rules cover every Phase 0 collection with a default deny, master writes only in P6, idempotency and pagination guards, `/ops` helper resolution, no product + phase-audit-doc mixing, focused lattice bundle parity. The scraper and provider guards (FA-CI-001) scan the whole tree: JS/TS import, export, `import()` and `require()` specifiers in any layout (comments between tokens included) and `createRequire` aliases, Python imports (parsed with `ast`), `package.json`, pip requirements files, `pyproject.toml`, `Pipfile`, Dockerfiles and shell scripts; an extensionless script is read as shell, JS or Python according to its shebang. They skip `node_modules`, `.git` and `.next` at any depth, and `ci_gates/`, `tests/`, `_superseded/` and `.eve/` only at the repository root. Exceptions are `file:symbol` entries in `ci_gates/g0_guard_allowlist.json`; an entry that no longer matches fails the gate. `tests/g0-gate-e2e.test.ts` runs the whole gate against planted violations. | `npm run gate:g0` |
| Lint | ESLint (Next core-web-vitals + TypeScript) reports no errors. | `npm run lint` |
| Unit + rules tests | The Next unit suite, plus the Firestore rules and persistence suites under the Firestore emulator. | `npm run test:all` (`npm test` for the unit suite alone) |
| Gate G-1 (forensic spine) | The ten Layer 18 §10.1 spine tests (`tests/gate_g1.test.ts`, labelled `G1-1` .. `G1-10`) exist and pass. | `npm run gate:g1` |
| Functions typecheck / build / tests | `functions/` type-checks, bundles, and its P5 identity, MFA, gates and HTTP suites pass under the Auth + Firestore emulators. | `npm --prefix functions run typecheck`, `npm --prefix functions run build`, `npm --prefix functions run test:emu` (on a busy machine use a temporary config with free ports: `functions/README.md` "Port notes") |
| **Gate G-2 (cross-firm isolation, L18 §10)** | With two firms seeded, every implemented read path (web and WhatsApp, D1-1, D1-2, D3-1, D5-1, D2-1, in memory and Firestore persistence), every P5 operation through the HTTP `api` (its only entry point, U-1) and every tenant collection in `firestore.rules` refuses firm B's six roles. Fails on any allowed cross-firm read, any read path the suites do not list, or a missing suite result. Prints the coverage table and an `evidence` line for `recordGatePass`; until a pass is recorded, `onboardFirm` refuses a second firm. | `npm run gate:g2` (local runs pick their own demo project and ephemeral ports; never edits `firebase.json`) |

## Security scans (`security.yml`: gitleaks and the dependency audit per ready PR; all three on push to main and weekly)

| Job | Proves | Run locally |
| --- | --- | --- |
| CodeQL (`javascript-typescript`, `python`) | Runs on every ready (non-draft) pull request, a push to main, every Monday and on demand (`workflow_dispatch`). No finding from the default and `security-extended` query suites in the Next app, `functions/`, `corpus_service/` and the gate scripts. Code scanning needs GitHub Code Security on this private repository and is off, so CI analyses without uploading and `ci_gates/check_codeql_sarif.py` fails on any result with security-severity ≥ 7.0 (high) or level error; the SARIF is kept as a run artifact. | `codeql database create … --build-mode=none --codescanning-config .github/codeql/codeql-config.yml`, then `codeql database analyze … <lang>-security-extended.qls --format=sarif-latest`, then the gate script. |
| Secret scan (gitleaks 8.30.1) | No commit in the push / PR adds a secret matching gitleaks' default rules, after the narrow fixture allowlists in `.gitleaks.toml` (UUID idempotency keys in test files, empty `.env.example` placeholders, the emulator `fake-api-key`, `demo-*` project ids). | `gitleaks git . --config .gitleaks.toml --log-opts="--all" --redact` (release binary from github.com/gitleaks/gitleaks/releases; verify its checksum) |
| **Dependency audit** | `npm audit --omit=dev --audit-level=high` (root, `functions/`) and `pip-audit` (`corpus_service/requirements.txt`) run report-only. The gate, `ci_gates/check_known_advisories.mjs`, fails on any high or critical npm advisory, or any pip-audit vulnerability, that is not listed for its scope in [`known-advisories.md`](known-advisories.md) with a reason and an owner; it fails closed on an unreadable report and prints stale rows. | `npm audit --omit=dev --json > /tmp/root.json; npm --prefix functions audit --omit=dev --json > /tmp/fn.json; pip-audit -r corpus_service/requirements.txt -f json -o /tmp/pip.json; node ci_gates/check_known_advisories.mjs --npm npm:root=/tmp/root.json --npm npm:functions=/tmp/fn.json --pip pip:corpus_service=/tmp/pip.json` |

Secret-scan baseline (2026-10-06): the full history (every remote ref of a
fresh mirror plus the local branches) had 1220 raw gitleaks findings, all
`generic-api-key`, all fixtures: UUID idempotency keys in test files and the
empty `ENCRYPTION_KEY=` placeholder in `corpus_service/.env.example`. No real
secret. With `.gitleaks.toml` the history scans clean.

## Mutation testing (weekly + manual, `mutation.yml`)

Proves that the tests of the security-critical modules detect planted bugs:
StrykerJS mutates the code (flips comparisons, drops conditions, empties
strings and blocks) and each mutant must make at least one test fail. Both
jobs fail below a mutation score of 85. Scores, the tests added to kill
survivors, and the equivalent mutants: [`mutation-report.md`](mutation-report.md).

| Run | Scope | Run locally |
| --- | --- | --- |
| Next app | `platform/p5` (session, request identity, checkPermission, committeeScope), `platform/p1/providerPolicy.ts` and `types.ts`, `platform/http/**`, `platform/flags/**`, the audit write path (`platform/persistence/audit*.ts`; there is no `platform/audit/`), `platform/persistence/runtimeRepositories.ts`. | `npm run mutation` |
| functions | `functions/src/p5/**`, `functions/src/http/**`, under the emulators: `scripts/mutation.sh` starts one independent Auth + Firestore emulator set per Stryker worker on ephemeral ports, and each worker claims its own set, so concurrent mutants cannot interfere. Needs Java (Firestore emulator). | `npm run mutation:functions` |

Reports: `reports/mutation/next/` and `functions/reports/mutation/`
(gitignored; HTML + JSON). Re-runs are incremental
(`stryker-incremental.json` in the report directory): only mutants whose code
or covering tests changed are re-tested. Delete that file for a full run.

Not part of per-PR CI because of runtime (measured on 4 cores): see
`mutation-report.md` "Runtime".
