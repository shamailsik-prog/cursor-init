# F21 plan: corpus lifecycle, registered consumers, completion boundary

Spec: `docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md` (rulings R1-R16). Branch `claude/remediate-f21` from `origin/main` @ c02ebbc. Test-driven: every behaviour change starts with a failing test, recorded in the ledger (section 3) with the exact command and count. Anything not run is marked NOT DEMONSTRATED.

Environment: one Python 3.12 venv from `corpus_service/requirements-test.txt`; PostgreSQL 16 + pgvector on 127.0.0.1:55591 (own cluster under `/tmp/f21-pg`, run as the `postgres` OS user), database `corpus_ci` with the Annex A DDL applied twice, as the CI corpus job does; `CI=1`, `CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://postgres:***@127.0.0.1:55591/corpus_ci`. Main's tree for RED runs is an export of c02ebbc (`git archive`), not a second worktree.

## 1. Tasks

1. **RED e2e** `tests/test_f21_corpus_lifecycle_e2e.py` (a)-(h) against the target behaviour; run on main's export, record the failures and the per-state counts main leaves.
2. **RED rules** `tests/test_f21_corpus_lifecycle_rules.py`: transition table, `move()`, CHECK SQL, beat entries, direct-write gate and its mutants, single-writer scan.
3. **Model + migration 005** (R1, R3, R5, R13): columns, CHECKs, index, transition model, job-type CHECK; `migrate.py` list; conftest `ORM_TABLES`.
4. **`scraper/tasks/lifecycle.py`** (R2, R3, R5): vocabulary, `move()`, run-job binding.
5. **Harvesters** (R12): PakistanCode and NationalAssembly to `statutes_staging`; routes `staging`; court labels removed; `job_id` stamped; dispatcher binds the run job.
6. **Normaliser** `scraper/tasks/normalise.py` (R6).
7. **Gate** in `scraper/tasks/promotion.py` (R7): lifecycle moves in `_decide` / `_quarantine_after_error`; statute decision; claim-based `gate_batch`; interruptions re-raised (R4).
8. **Retrieval projection** `scraper/publication/retrieval.py` and **publish consumer** `scraper/tasks/publish.py` (R8, R9, R10).
9. **Reconciler** `scraper/tasks/reconcile.py` (R11) with its CLI.
10. **Consumers and beat** `scraper/tasks/corpus_pipeline.py` + `celery_app.py` (R4, R5); `job_record.record_consumer_run`.
11. **Changed expectations** in the four existing tests the spec names; F20 allowlist entry for `scraper.publication.retrieval`.
12. **README** runbook section; spec ledger cross-check.
13. **Verification**: full corpus suite as CI runs it; G-0; F31 import contract; F31 runtime smoke (runtime imports change); mutation (at least 12 mutants); gitleaks; claim gate on the PR body.

## 2. Decisions taken while planning

| # | Decision | Reason |
| --- | --- | --- |
| D1 | `promote_staging_records()` keeps its signature, selector and blocking `FOR UPDATE` (F20 test_h pins that it waits on a locked row); the scheduled gate is a new claim loop that shares `_decide` | F19/F20 suites must pass unchanged; the claim loop needs `SKIP LOCKED` |
| D2 | Lifecycle moves are written inside `_decide` and `_quarantine_after_error`, so both the legacy routine and the consumer keep state and flags together; a legacy row staged `normalised = true` at `parsed` is first moved `parsed` → `normalised` (reason `normalised_by_writer`) | one decision path, no drift between flags and state |
| D3 | Every master-table access of the lifecycle lives in `scraper/publication/retrieval.py`, the one new entry on F20's writer allowlist | the F20 scanner allowlists by module |
| D4 | Consumer tasks live in one module (`corpus_pipeline.py`) that `celery_app` imports; the logic modules import no Celery | `promotion.py` is imported by the API (F23's route); keep Celery task objects out of it |
| D5 | Tests run the four lifecycle beat entries per tick, not `process-embeddings` | the flow stops at the outbox row (brief); no provider |

## 3. RED/GREEN ledger

Runner: `scratchpad/f21-pytest.sh <tree> <log> [args]` = `CI=1 CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://postgres:***@127.0.0.1:55591/corpus_ci python -m pytest corpus_service/tests -q -p no:cacheprovider [args]`; `scratchpad/f21-only.sh` runs only the named files. Main's tree is `git archive c02ebbc` under `/tmp/f21-pg/main-tree`.

| # | Step | Tree | Command | Result |
| --- | --- | --- | --- | --- |
| L1 | Baseline | main c02ebbc | full suite | 1168 passed, 157 subtests, 516 s |
| L2 | RED | main c02ebbc + the two F21 test files (commit f0de9b9) | full suite | 19 failed, 1169 passed (the 1 extra pass is the scanner self-test); 552 s |
| L3 | RED detail, test (a) | main | as L2 | after 2 harvests and 3 ticks: case records `{('NasirLawSite', 'main:unnormalised'): 10}`, 0 review-queue rows, 0 `statutes_staging` rows, 8 `statutes_master` rows written by the harvests (PakistanCode 4, NationalAssembly 4: NA duplicated on its second run), second PakistanCode harvest FAILURE `IntegrityError (SQLSTATE 23505)`, 0 outbox rows, no transition log |
| L4 | RED detail, (b)-(h) and rules | main | as L2 | (b) `({('NasirLawSite', 'main:unnormalised'): 5}, 0)` review rows; (c)(f)(g)(h) `UndefinedColumn` (no lifecycle state, no `state_changed_at`: no stalled-row visibility); (d)(e) `KeyError 'normalise-corpus'` (no consumer on the beat); rules: direct routes `{NationalAssembly, PakistanCode}`, master writers `pakistancode` :46, :51 and `nationalassembly` :35 |
| L5 | First GREEN run of the F21 files | branch, uncommitted | `f21-only.sh` e2e, `-x` | 1 failed: every assertion of (a) held except "every tick succeeded": the reconcile tick raised `DBAPIError ... invalid input for query argument $1: '604800 seconds'` (asyncpg types `CAST(:p AS interval)` as an interval and wants a `timedelta`). Fixed in `reconcile.py` (pass `timedelta`) |
| L6 | Second run | branch | `f21-only.sh` e2e | 8 passed, 1 failed: (d) one worker claimed all 40 records and the second hung in `BEGIN` until teardown. Cause (systematic debugging): two event loops racing a brand-new engine's first connect, the artefact F20's concurrency test documents and avoids by connecting once first. Fix in the test (connect once before the threads; each production worker has its own engine). Also made the race real: each worker's first step now waits until the other holds a claim (a barrier inside the step), so a single worker can no longer drain the batch before the other starts; the consumer steps are looked up when called (late binding) so a test can wrap one |
| L7 | Third run | branch | `f21-only.sh` e2e + rules | 22 passed, 31 s |
| L8 | Tests added to kill mutants (spec section 3: (i) a failing record, (j) trust re-read at publication, (k) concurrent copies of one document, (l) a review-source statute; (c) gains an attached copy; rules gain F23's lock namespace, the deterministic ids and the harvester staging sites) | branch | `f21-only.sh` F21 files + `test_f20_harvesters_db.py` + `test_trust_policy.py` | 63 passed, 110 subtests, 76 s |
| L9 | Full suite with the four direct-write tests still in their pre-F21 form (the run collected them before their expectations were changed) | branch, implementation in place | full suite | 4 failed, 1186 passed, 157 subtests, 639 s. The four are exactly the tests that pin the removed direct writes: `test_f20_harvesters_db::test_f_direct_publishers_write_master_rows_only_for_a_trusted_source` (`('PakistanCode', 'trusted'): 0` master rows from the harvest), `test_f26_pdf_intake_e2e::test_r1...[scrape-na]` (no `statutes_master` row), `test_f28_fu_prefork_e2e::test_m1_a_time_limit_while_awaiting...` and `::test_m1_a_time_limit_inside_harvester_code...` (`assert 0 == 3` on `statutes_master`) |
| L10 | The changed tests after their expectation change | branch | `f21-only.sh` the F20 direct-publishers test, F26 `test_r1...`, and the three F28 e2e files | 65 passed, 158 s |
| L11 | Commit c0f3925 (implementation + changed expectations); then origin/main moved to 062c7bb (F27 #87 merged, F18 #88): merged into the branch as 998fae5. Conflicts: `migrate.py` (004 and 005 both listed), `conftest.py` `ORM_TABLES` (both new tables), README (both sections). `models.py` merged cleanly | branch | `git merge origin/main` | resolved; rules + trust policy + F31 import contract + F27 rules: 137 passed, 110 subtests |
| L12 | GREEN, full suite on the merge (F27's code and tests included) | 998fae5 | full suite, `CI=1` | **1245 passed, 157 subtests, 0 failed, 835 s** (load 7-11 on 4 cores) |
| L13 | The F21 files alone (CI time added) | 998fae5 | `f21-only.sh` F21 files `--durations=15` | 27 passed in 43.3 s at load ~9; the slowest are (d) 5.3 s, (a) 4.9 s, (b) 4.3 s, (h) 4.0 s |
| L14 | Gate G-0 | 998fae5 | `BASE=origin/main bash ci_gates/gate_g0.sh` | PASSED (static) |
| L15 | Mutation | copies of 998fae5 under `/tmp/f21-pg/mut` | `scratchpad/f21-mutate.py` (one exact replacement per mutant; the named tests with `-x`) | 18 mutants, 18 killed (M06 survived its first named test and is killed by (a); table below) |

### Mutation table (L15)

| Mutant | Area | Change | Killed by | Result |
| --- | --- | --- | --- | --- |
| M01 | transition guard | `is_legal` always true | rules `test_move_refuses_an_illegal_move...` (`IllegalTransition not raised: ('parsed', 'approved')`) | killed |
| M02 | transition guard | the reason check of a terminal-bad state removed | rules `test_move_refuses_a_terminal_bad_state...` | killed |
| M03 | transition CHECK | the log CHECK lists an illegal pair (`parsed>embedded`) | rules `test_the_database_checks_are_built_from_the_same_table` | killed |
| M04 | claim (SKIP LOCKED) | `.with_for_update()` without `skip_locked` | (d) `test_d_a_record_locked_elsewhere_is_skipped_not_waited_on` ("the tick waited on the locked record") | killed |
| M05 | claim | the tick's tried-record exclusion removed | (i) (the failing record is re-claimed until the breaker aborts; the tick fails with `BatchFailed`) | killed |
| M06 | claim | the state condition removed | (d) passes (one pass per consumer cannot see it); the whole e2e file: (a) fails (`quarantined>dead_letter` for every review record) | survived (d), killed by (a) |
| M07 | normaliser claim / dedup | the dedup advisory lock removed | (k) (`Counter({'normalised': 2})`) | killed |
| M08 | reconciler | a published record moved on without its outbox row | (g) | killed |
| M09 | reconciler | the orphan-review phase removed | (g) | killed |
| M10 | stalled alert | the 7-day review threshold replaced by 6 h | (f) | killed |
| M11 | stalled alert | `<` turned to `>` (fresh rows alert) | (f) (`2 == 3` lines) | killed |
| M12 | direct-write gate | the gate ignores `direct` routes | rules `test_mutants_that_put_a_direct_write_back_are_caught` | killed |
| M13 | direct-write gate | NationalAssembly writes `statutes_master` again | rules `test_no_source_task_writes_a_master_table...` (`instantiation line 61`) | killed |
| M14 | review gate (F23 sync) | a rejected decision treated as promoted | (b) (`('embedded', 'dead_letter') != ('embedded', 'rejected')`) | killed |
| M15 | review gate (statutes) | a review-source statute approved | (l) | killed |
| M16 | publication | trust not re-read at publication | (j) | killed |
| M17 | harvester | SHC labels quarantine again | rules `HarvesterStagingTests` | killed |
| M18 | retrieval projection | the citation attach removed | (c) (the copy dead-lettered `publish_error:23505` at commit) | killed |

M05's kill surfaced as `TypeError` in (i) (the test read `result["claimed"]` of a failed task); (i) now asserts the task state first, so the same mutant fails with a readable message.
