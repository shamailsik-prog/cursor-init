# F15 PII Mask Normalisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the outbound mask sees identifiers in every digit script and through invisible characters, matches recorded names through case, spacing and Arabic-letter variants, and the rank >= 3 obligation is checked by an independent residual detector whose counts are recorded on every call.

**Architecture:**
- `platform/p1/piiText.ts` builds a detection view (NFKC, digits to ASCII, dashes, spaces, invisibles dropped) with a per-unit map to original offsets, and a folded name view on top of it.
- `maskOutboundPII` runs main's patterns and the folded names on the views in one pass and replaces the mapped spans in the original text.
- `platform/p1/residualPII.ts` scans the masked text's detection view by digit-run length and contextual cues; `assertMinimised` requires both a clean mask re-run and zero residual findings.
- `callP1` records `residualCounts` beside `redactionCounts`; committeeBrain adds the matter's client record names.

**Tech Stack:** TypeScript, vitest, firebase-admin, the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md`

## Global Constraints

- Do not edit `platform/http/withSession.ts`, `platform/p5/session.ts`, `platform/persistence/adminFirestore.ts`, `platform/persistence/firestoreSpineRepositories.ts`, `platform/p5/committeeScope.ts`, `platform/p5/insecureDevAuth.ts`; no `app/api/**`.
- Never skip or weaken a test. Exact-shape assertions that list `outbound` keys gain `residualCounts`; nothing else in an existing test changes.
- Invented names only (Qalvo, Nura, Tariq Zarvani, Haris Qalbani, Omer Daryani, Kamran); synthetic numbers.
- Emulators on private ports (a scratch copy of `firebase.json` with its own ports, never committed).
- Invisible and space characters are written as `\u` escapes in source (eslint `no-irregular-whitespace`).

## Review Focus

- The output keeps every unmatched code unit of the original (pinned by an exact-equality test with zero-width and NBSP characters outside matches).
- No catastrophic backtracking on 100,000 characters (pinned by a time-bounded test).
- The false-positive corpus produces zero residual findings; each refinement in spec ruling 5 has its own test row.
- The receipt path tolerates a pre-F15 receipt without `residualCounts` (F09 resume).

---

### Task 1: Spec and plan

- [x] Write the spec (rulings 1-9, residual risk) and this plan.

### Task 2: RED tests on main's sources

**Files:** create `tests/f15-detection-view.test.ts`, `tests/f15-mask-unicode.test.ts`, `tests/f15-residual-pii.test.ts`, `functions/test/f15-pii-mask.e2e.emu.test.ts`.

- [x] Write the four files before any implementation.
- [x] Run them with the sources still identical to main 0844ed8; record the failures (scratchpad logs, then the PR body).

### Task 3: Detection view and name view

**Files:** create `platform/p1/piiText.ts`.

- [x] `detectionView(text)`: `{ text, start, end }`, per original code point: `\p{Cf}` dropped; NFKC; `\p{Nd}` to ASCII by the run-start rule; `\p{Pd}` and U+2212 to `-`; `\p{Zs}` to a space. ASCII fast path.
- [x] `nameView(view)` and `foldName(name)`: lower-case, NFD minus `\p{M}`, tatweel dropped, the Arabic letter folds of ruling 3.
- [x] `tests/f15-detection-view.test.ts` GREEN.

### Task 4: The mask on the views

**Files:** modify `platform/p1/maskOutboundPII.ts`.

- [x] Patterns on the detection view, priority order kept, accepted spans blanked with U+E000.
- [x] Names: folded, de-duplicated, longest first, whitespace as `\s*`, matched on the name view built from the blanked detection view.
- [x] Output assembled from original slices and tokens; overlapping spans merged.
- [x] Header: risk reduction, not anonymisation; the list of gaps.
- [x] `tests/f15-mask-unicode.test.ts` mask cases GREEN; `tests/p1.outbound-mask.test.ts`, `tests/p1.provider-policy.table.test.ts`, `tests/p1.eve-committee-brain.test.ts` still GREEN.

### Task 5: Residual detector

**Files:** create `platform/p1/residualPII.ts`.

- [x] `residualPII(text)`: four kinds, counts only, on the detection view; refinements of ruling 5.
- [x] `tests/f15-residual-pii.test.ts` GREEN (true positives, false-positive corpus, bound).

### Task 6: assertMinimised

**Files:** modify `platform/p1/providerPolicy.ts`.

- [x] Mask re-run clean and `residualPII` zero, on body and purpose.
- [x] Truth table in `tests/f15-mask-unicode.test.ts` GREEN.

### Task 7: Functions wiring

**Files:** modify `functions/src/p1/gateway.ts`, `functions/src/p1/ops.ts`; modify `functions/test/p1.gateway.emu.test.ts`, `functions/test/p1.api.emu.test.ts` (exact key lists only).

- [x] `outbound.residualCounts` on every call; `P1Result["outbound"]` type.
- [x] `outputRow` writes `metadata.residualCounts`; `receiptOf` validates it when present.
- [x] `partyNamesFor` reads `clients/{matter.clientId}` in parallel with `matter_parties` and adds `canonicalName`, `companyName`, `concernedPersonName` for the caller's firm.
- [x] `functions/test/f15-pii-mask.e2e.emu.test.ts` GREEN on private-port emulators.

### Task 8: Docs

**Files:** modify `functions/src/p1/README.md`.

- [x] Steps 4 and 5, the `not_minimised` row, `residualCounts` on the output row, the client read in the query table, the "not anonymisation" statement and its gaps.

### Task 9: Verification

- [x] New and changed tests RED against main's sources (temporary checkout of main's source files, restored after).
- [x] `npm run test:unit`; `npm --prefix functions run typecheck`; `npm --prefix functions run build`; the Functions emulator suite (`test:emu`, private ports); the rules suite (`test:rules`, private ports); `npm run lint`; `npm run typecheck`; `npm run typecheck:tests`; `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [x] Re-read the diff adversarially; PR body through `ci_gates/check_pr_phase_claims.py`.

## Execution record

Execution was native (inline), self-approved under the owner's standing autonomy instruction. Emulator runs used the repo's rules and indexes on their own ports (a scratch copy of `firebase.json`, not committed), because other sessions on the host may hold `firebase.json`'s.

- RED, the branch's new and changed tests against an exact `origin/main` 0844ed8 tree: unit 48 failed / 10 passed (58), with `f15-detection-view` and `f15-residual-pii` unable to load their new modules; Functions (F15 e2e, p1.api, p1.gateway) 8 failed / 214 passed (222). The two F15 e2e cases that pass on main are compatibility guards ((d') and a pre-F15 receipt).
- GREEN at the branch head: `npm run test:unit` 170 files, 3500/3500; the `test:rules` file set 13 files, 680/680; the P1/F09/F15/p2-scheduled emulator subset 7 files, 315/315; `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` and `build` exit 0; `npm run lint` 0 errors (89 warnings, none in a touched file); G-0 PASSED.
- The full Functions emulator suite (CI's `test:emu`): 66 of 67 files and 1628/1632 tests pass. The four failures are 15 s timeouts in `p2.jobs-scheduled`, which scans every firm the earlier files left behind. On an exact `origin/main` tree in the same environment, the same suite fails the same file the same way (3 timeouts; 1621/1624). The file passes in smaller runs: 6/6 beside the F15 file alone, and 6/6 in the P1 subset after `p1.api`, `p1.gateway` and `f09`. Its cost grows with the number of firms already in the emulator, so it fails only late in the full run. This is environmental, not an F15 regression.
- Found on the way: main's EMAIL regex backtracked quadratically (spec ruling 2). It is fixed here.

## Round 2: re-audit round 1 (FAIL 6/10)

Spec §7, rulings R2-1 to R2-6. Same constraints: TDD (each new test seen failing first), no #44 files, no `app/api/**`, escapes for invisible characters, no PR opened or edited by the builder.

### Task R2-A: the re-auditor's inputs as RED tests

**Files:** create `tests/f15-r2-corpus.ts` (the 126-line corpus, verbatim), `tests/f15-r2-mask.test.ts`, `tests/f15-r2-residual.test.ts` and `tests/f15-r2-bounds.test.ts`. Modify `functions/test/f15-pii-mask.e2e.emu.test.ts`: add rows (f) to (h), correct the header and rename (d′).

- [x] Write them before any implementation change. Run them against 92cf971's sources and record the failures.

### Task R2-B: detection view (R2-1, R2-5)

- [x] Drop `\p{Default_Ignorable_Code_Point}` and `\p{M}`.
- [x] Map enclosed and dingbat digits, and Arabic and ideographic separators.
- [x] Name view: Cyrillic and Greek fold, do-chashmi he, dots dropped, `_` and `-` read as spaces.
- [x] ASCII fast paths.

### Task R2-C: mask (R2-2, R2-4, R2-5)

- [x] Bounded separators; the IBAN first.
- [x] Patterns: general mobile, UAN, landline, NTN variants, labelled and unlabelled passport, Unicode email.
- [x] A span extends over trailing marks; the view is re-joined only after a change; honorific-free name variants; `MASK_CUES`.

### Task R2-D: residual detector (R2-2, R2-3, R2-4)

- [x] Cue regexes generated from exported word lists (`RESIDUAL_CUES`); no whitespace quantifiers meeting around an optional part.
- [x] The rulings a to h, with the refinements recorded in spec §7.

### Task R2-E: docs

- [x] Spec §7 and §5.
- [x] Mask header; README "What the mask does and does not do" and its tests paragraph.

### Task R2-F: verification

- [x] RED and GREEN as recorded below; PR body `pr-body-r2.md` through `ci_gates/check_pr_phase_claims.py`.

### Round-2 execution record

**RED, against 92cf971's sources** (the tests were committed first, at 4cb652c):
- `tests/f15-r2-mask.test.ts` and `tests/f15-r2-residual.test.ts`: 144 failed / 122 passed (266). Every failure is an assertion: identifiers sent unmasked, or clean prose counted.
- `tests/f15-r2-bounds.test.ts`: 7 failed / 7. The six audit inputs took 24.4 to 42.1 s each against a 1.5 s bound; the modules exported no cue lists.
- `functions/test/f15-pii-mask.e2e.emu.test.ts`: 10 failed / 13 passed (23).
  - Five rank-3 identifiers reached the provider.
  - The parentage clause after a role and a name was not blocked.
  - Three clean privileged bodies were blocked.
  - The quadratic body answered 503 `precall_deadline`.

**GREEN, at the round-2 tree:**
- `npm run test:unit`: 173 files, 3948/3948.
- `tests/f15-r2-bounds.test.ts`: 182/182. The worst cue took 0.99 s for eight 100,000-character inputs; the six audit inputs took 45 to 151 ms.
- The `test:rules` set: 13 files, 680/680.
- The Functions F15 e2e, p1.api, p1.gateway, both f09 files and p1.units: 324/324.
- `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` and `build`: exit 0.
- `npm run lint`: 0 errors (89 warnings, none in a touched file).
- G-0: PASSED.

**False-positive rates.**
- The re-auditor's corpus: 0 of the 124 clean lines are flagged. The two lines ruled true positives count as ruled.
- The mask leaves all 126 lines unchanged.
- Round 1's own corpus (36 lines) and the round-2 row-by-row passes (37): 0 flagged.

**Changed round-1 expectations (each follows a ruling):**
- the NFKC-expansion span test now uses U+FB01;
- do-chashmi he now folds to heh goal;
- the Urdu phone-label row now has seven digits.

## Round 3: re-audit round 2 (FAIL 7/10)

Spec §8, rulings R3-1 to R3-8. Same constraints: TDD (each new test seen failing first, RED recorded against 15a5385), no #44 files, no `app/api/**`, escapes for invisible characters, no PR opened or edited by the builder.

### Task R3-A: held-out corpus, before any code (R3-6)

- [x] Write `tests/f15-r3-heldout-corpus.ts` (134 lines, English and Urdu, FIR, plaint, judgment, bail and bond style) and commit it alone (d8d53cf), before reading the re-auditor's fresh corpus.
- [x] Split the fresh corpus by 1-based line number; read only the even lines (`FRESH_TUNING` in `tests/f15-r3-fresh-corpus.ts`).

### Task R3-B: the re-auditor's inputs as RED tests

**Files:** create `tests/f15-r3-mask.test.ts` (with main's patterns as the differential oracle), `tests/f15-r3-residual.test.ts`, `tests/f15-r3-bounds.test.ts` and `tests/f15-r3-fresh-corpus.ts`. Modify `functions/test/f15-pii-mask.e2e.emu.test.ts`: add rows (i) and correct the header.

- [x] Commit them (8ab390b) and run them against 15a5385's sources.

### Task R3-C: the mask (R3-1, R3-2, R3-7)

- [x] Stage 1: main's patterns in main's order (the mobiles also take the country prefix; the anchored email ends where main's did).
- [x] Stage 2: unbounded CNIC, IBAN, NTN and passport separators; the mobile separator class with the exclusive slash alternatives and the date guard; the wider email ending; the grouped CNIC last.
- [x] Detection view: U+2800 and U+303F to a space, `\p{Co}` dropped.

### Task R3-D: the residual detector (R3-2 to R3-7)

- [x] Dates read off a digit run; whole-value label minimums; the kinship walk; plural, verb and locality residence cues; the address label anywhere; numbered-place followers; exemption limits.

### Task R3-E: measure, then fix and add the held-out rows (R3-6)

- [x] Measure the three rates at 76902de. Then fix the three held-out failures and the e2e sentence-end regression (c532fe4), and add every held-out line as a regression row.

### Task R3-F: docs and verification

- [x] Spec §8 and §5; mask header; README; this record; PR body `pr-body-r3.md` through `ci_gates/check_pr_phase_claims.py`.

### Round-3 execution record

**Order of work.**
1. d8d53cf: the held-out corpus, alone.
2. 8ab390b: the RED tests.
3. 76902de: the implementation, the measured state.
4. c532fe4: the held-out fixes and regression rows.
5. 53ecdc6: docs, and the wider-class CNIC rows.
6. This record.

**RED, against 15a5385's sources:**
- `tests/f15-r3-mask.test.ts`: 46 failed / 22 passed (68), all three differential seeds included.
- `tests/f15-r3-residual.test.ts`: 86 failed / 81 passed (167), including 15 of the 60 tuning lines.
- The three wider-class CNIC rows added at 53ecdc6: 3 failed / 3.
- `functions/test/f15-pii-mask.e2e.emu.test.ts`: 14 failed / 23 passed (37), every row of (i).
- `tests/f15-r3-bounds.test.ts`: 46 / 46 (15a5385's separators were bounded). Mutants M1 and M2 show it catches what it guards.
- After the measurement, 4 failed at 76902de and pass at c532fe4: held-out lines 37, 69 and 121, and "son of Respondent No. 2. Draft the grounds."

**False-positive rates (R3-6), at 76902de:**
- fresh even (tuned on): 0 / 60;
- fresh odd (held out): 2 / 60, lines 37 and 69;
- new corpus (held out): 1 / 134, line 121;
- both held-out sets: 3 / 194 (1.5%).

At the head: 0 of 254.

**Mutants** (spec §8): M1 to M6 are all killed.

**GREEN, at 53ecdc6:**
- `npm run test:unit`: 176 files, 4506/4506.
- The `test:rules` set: 13 files, 680/680.
- The Functions F15 e2e, p1.api, p1.gateway, both f09 files and p1.units: 338/338.
- The full Functions emulator suite, under a hard timeout: 66 of 67 files, 1660/1661. The one failure is a 15 s timeout in `p2.jobs-invariants` (skewed clocks), late in the run. That file passes alone (5/5; the test takes 1.8 s) and beside the F15 file and `p2.jobs-scheduled` (48/48). Late-run 15 s timeouts in the p2 job files also occur on an exact `origin/main` tree in this environment (round 1, and the re-auditor's main run). This is environmental, not an F15 regression.
- `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` and `build`: exit 0.
- `npm run lint`: 0 errors (89 warnings, none in a touched file).
- G-0: PASSED.

**Timings** (rank-3 work at 100,000 characters, best of three, `profile3.ts`):
- every separator-run and repetition shape: at most 296 ms with 50 names;
- U+FDFA × 100,000: 1.8 s with no names, 3.0 s with 50.

The bound tests: the round-2 matrix (258 tests, with the round-3 cues) and the round-3 shapes (46 tests) pass at 1.5 s per input.

**Changed earlier expectations:** none.

## Round 4: re-audit round 3 (FAIL 8/10)

Spec §9, rulings R4-0 to R4-6. Same constraints: TDD (RED recorded against adc5aa0), no #44 files, no `app/api/**`, escapes for invisible characters, no PR opened or edited by the builder. First, origin/main (d7f6a2c, #60) was merged with a merge commit (354a4d3).

### Task R4-A: held-out corpus, before any code (R4-6)

- [x] Write `tests/f15-r4-heldout-corpus.ts` (99 lines: 50 English, 49 Urdu; affidavits, deeds, notices, family, revenue, police, medical, service, banking, orders, judgments) and commit it alone (b48fc83), before any round-4 test or code.

### Task R4-B: the re-auditor's inputs as RED tests

**Files:** create `tests/f15-r4-mask.test.ts` (main's mask as the oracle; the re-auditor's differential generator), `tests/f15-r4-residual.test.ts` and `tests/f15-r4-bounds.test.ts`. Modify `functions/test/f15-pii-mask.e2e.emu.test.ts`: add rows (j).

- [x] Commit them (e6f14fa) and run them against adc5aa0's sources.

### Task R4-C: the mask (R4-1)

- [x] Stage 0: main's algorithm on the raw text; the union of spans; `outboundPIISpans`; counts from the tokens written.
- [x] An exact span differential, with the greedy alignment kept as the fallback.

### Task R4-D: the residual detector (R4-0, R4-2 to R4-5)

- [x] Card numbers and the amount bound; the skipping kinship walk; residence rules; Urdu false positives; the T24 pin.

### Task R4-E: measure, then fix and add the held-out rows (R4-6)

- [x] Measure both corpora at 57fd1c2. Fix the new corpus's three lines (c306407). Add both corpora as regression rows, with the four ruled lines as count rows.

### Task R4-F: docs and verification

- [x] Spec §9 and §5; mask header; README; this record; PR body `pr-body-r4.md` through `ci_gates/check_pr_phase_claims.py` with BASE origin/main.

### Round-4 execution record

**Order of work.**
1. 354a4d3: origin/main (d7f6a2c, #60) merged with a merge commit; it changes no F15 file.
2. b48fc83: the new held-out corpus, alone.
3. e6f14fa: the RED tests.
4. 57fd1c2: the implementation, the measured state.
5. c306407: the held-out fixes and regression rows (both corpora).
6. 379a255: two lower-case rows after an occupation (they kill mutant M8).
7. b9d684b: docs (spec §9 and §5, README, mask header).
8. This record.

**RED, against adc5aa0's sources:**
- `tests/f15-r4-mask.test.ts`: 9 failed / 9 passed (18). Five glue rows and all four differential seeds fail.
- `tests/f15-r4-residual.test.ts`: 45 failed / 36 passed (81). The two rows added at 379a255 fail too.
- `functions/test/f15-pii-mask.e2e.emu.test.ts`: 8 failed / 38 passed (46): two glue rows reached the provider and six clauses were sent. The passing new row pins the fail-closed پسر اکبر.
- `tests/f15-r4-bounds.test.ts`: 21 / 21. It guards the round-4 additions.
- After the measurement, 3 failed at 57fd1c2 and pass at c306407: the new corpus's lines 77, 96 and 99.

**False-positive rates (R4-6), at 57fd1c2:**
- the re-auditor's round-3 corpus (held out): 4 / 102. English 1 / 55 (line 49), Urdu 2 / 45 (lines 84 and 88), "debatable" 1 / 2 (line 101). All four fail closed by rulings R4-3 and R4-4.
- the new corpus (held out): 3 / 99. English 0 / 50, Urdu 3 / 49 (lines 77, 96 and 99).
- both held-out sets: 7 / 201 (3.5%).

At the head, the four ruled lines are count rows and every other line of both corpora is clean.

**Differential (R4-1):** the re-auditor's generator, seeds 1017, 2026, 4242 and 99991 × 6,000 inputs. Span by span, there are 0 inputs where the mask keeps a unit main replaced. The re-auditor's greedy alignment, run on the same inputs against the round-4 mask, reports 118 differences, 6 of them with an "@"; each is an alignment artifact.

**Mutants** (spec §9): T03, T05, T24, M7, M8 and M9 are all killed.

**GREEN, at b9d684b:**
- `npm run test:unit`: 179 files, 4855/4855.
- The `test:rules` set: 13 files, 680/680.
- The Functions F15 e2e, p1.api, p1.gateway, both f09 files and p1.units: 6 files, 347/347.
- The full Functions emulator suite, under a hard timeout (3,600 s): 66 of 67 files, 1667/1671. The four failures are 15 s timeouts in `p2.jobs-scheduled`, late in the run (the file took 94 s there; one of its passing tests took 33 s). That file passes alone (6/6; its slowest test takes 0.6 s) and beside the F15 file and `p2.jobs-invariants` (57/57). Its code imports nothing this branch changes (only types from `platform/p1/types`, which is unchanged). As with round 3's late `p2.jobs-invariants` timeout, this is the environment, not an F15 regression; main's full suite was not re-run this round.
- `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` and `build`: exit 0.
- `npm run lint`: 0 errors (89 warnings, none in a touched file).
- G-0: PASSED.

**Timings** (rank-3 work at 100,000 characters, best of three; the round-3 shapes plus 21 round-4 shapes):
- every separator-run, repetition and round-4 shape: at most 1,011 ms with 50 names (the Urdu phrase کا باشندہ repeated; 940 ms with none);
- U+FDFA × 100,000: 1.8 s with no names, 3.0 s with 50, as in round 3.

The bound tests: the round-2 matrix, the round-3 shapes and the 21 round-4 shapes (350 tests) pass at 1.5 s per input.

**Changed earlier expectation:** `tests/f15-r3-residual.test.ts`, round 3's held-out fresh line 69 ("The complainant shifted to House No. 7 after the occurrence.") is a count row by ruling R4-3.

## Round 5: re-audit round 4 (FAIL 7/10)

Spec §10, rulings R5-1 to R5-5 (R4-0 still governs). Same constraints: TDD (RED recorded against 810fa74), no #44 files, no `app/api/**`, escapes for invisible characters, no PR opened or edited by the builder. origin/main had not moved (d7f6a2c), so no merge was needed.

### Task R5-A: held-out corpus, before any code (R5-5)

- [x] Write `tests/f15-r5-heldout-corpus.ts` (92 lines: 50 English, 42 Urdu; tax, company, banking, consumer, labour, election, accountability, anti-terrorism, rent, family, succession, constitutional, service, police, revenue, cheques, defamation, cyber crime, procurement) and commit it alone (d65c895), before reading the re-auditor's round-4 adversarial lines.

### Task R5-B: the re-auditor's inputs as RED tests

**Files:** create `tests/f15-r5-mask.test.ts` (main's mask as the oracle; drift rows; the differential generator joins 3 to 8 emails and checks stage 0 against main), `tests/f15-r5-residual.test.ts` and `tests/f15-r5-bounds.test.ts` (joined-email runs with a heap limit). Modify `functions/test/f15-pii-mask.e2e.emu.test.ts`: add rows (k). Change the two U13 rows (R5-2).

- [x] Commit them (d0ff97c) and run them against 810fa74's sources.

### Task R5-C: the mask (R5-1)

- [x] `matchesOf`: one exec loop per pattern, resuming at the chain's end; stage 0 and `take()` use it.
- [x] `mainAlgorithmSpans`: stage 0 exported, overlaps merged before blanking; EMAIL_RAW starts where main's word boundary did.

### Task R5-D: the residual detector (R5-2 to R5-4)

- [x] The eight-word English walk; offices like roles; organisation, nationality and country words skipped; finite auxiliaries end it.
- [x] Urdu residence words with a place on either side; origin cues; settled and residence; address of a role; C/o; table separators; the ten-word window.

### Task R5-E: measure, then fix and add the held-out rows (R5-5)

- [x] Measure both corpora at 86c42a2. Fix new-corpus line 67, test first (ce626f0). Add both corpora as regression rows, with the four ruled lines as count rows.

### Task R5-F: mutants, docs and verification

- [x] Round-5 mutants; pins for M13 and M14 (6c35c2d).
- [x] Spec §10 and §5; mask header; README; this record; PR body `pr-body-r5.md` through `ci_gates/check_pr_phase_claims.py` with BASE origin/main.

### Round-5 execution record

**Order of work.**
1. d65c895: the new held-out corpus, alone.
2. d0ff97c: the RED tests, and the two U13 rows changed by ruling R5-2.
3. 86c42a2: the implementation, the measured state.
4. ce626f0: the held-out fix (new line 67, test first) and both corpora as regression rows.
5. 6c35c2d: pins for mutants M13 and M14.
6. c091844: docs (spec §10 and §5, README).
7. This record.

**RED, against 810fa74's sources:**
- `tests/f15-r5-mask.test.ts`: 13 failed / 1 passed (14). The differential missed 227, 199, 196 and 202 inputs per seed; the underscore row is a guard.
- `tests/f15-r5-residual.test.ts`: 35 failed / 27 passed (62).
- The two rows changed by R5-2 (U13): 2 failed.
- `tests/f15-r5-bounds.test.ts`: the first joined-email row ran the worker out of memory; `a@b.pk_` alone took 57.6 s; the 14 cue rows pass (guards).
- `functions/test/f15-pii-mask.e2e.emu.test.ts`: 8 failed / 46 passed (54). The glued NTN reached the provider shifted; the 48,000-character run answered 503 `precall_deadline` after 28.9 s; six clauses were sent.
- After the measurement, 2 failed at 86c42a2 and pass at ce626f0: new line 67 and the ساتھ row.

**False-positive rates (R5-5), at 86c42a2:**
- the new corpus (held out): 2 / 92 (English 0 / 50, Urdu 2 / 42: lines 67 and 74);
- the re-auditor's round-4 corpus (held out): 3 / 128 (English 0 / 64, Urdu 0 / 59, "debatable" 3 / 5: lines 125, 126, 128);
- both held-out sets: 5 / 220 (2.3%).

At the head the four ruled lines (new 74, fresh 125, 126, 128) are count rows and every other line of both corpora is clean. The re-auditor's 43 adversarial clean probes, for information: 25 flagged at 810fa74, 22 at 86c42a2.

**Differential (R5-1):** the generator joins 3 to 8 emails with ".", "-" or "_"; seeds 1017, 2026, 4242 and 99991 × 6,000. 0 inputs where the mask keeps a unit main replaced; 0 where stage 0's spans differ from main's.

**Mutants** (spec §10): U21, U24, U25a, U25b, M10, M12, U06, U36 and M13 to M20 are all killed. M13 and M14 needed the pins of 6c35c2d. Removing the merge before stage 0's blanking is an equivalent mutant (a safety net).

**GREEN, at 6c35c2d (code and tests):**
- `npm run test:unit`: 182 files, 5201/5201, wall time 3 min 50 s.
- The `test:rules` set: 13 files, 680/680.
- The Functions F15 e2e, p1.api, p1.gateway, both f09 files and p1.units: 6 files, 355/355.
- The full Functions emulator suite, under a hard timeout (3,600 s): 66 of 67 files, 1675/1679. The four failures are 15 s timeouts in `p2.jobs-scheduled`, late in the run: the same four the re-auditor reproduced on an exact main tree in the same file order (round 4). The file passes beside the F15 file (60/60).
- `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` and `build`: exit 0.
- `npm run lint`: 0 errors (89 warnings, none in a touched file).
- G-0: PASSED (at the head).

**Timings** (rank-3 work at 100,000 characters, best of three; `profile5.ts`):
- the 24 separator-run and repetition shapes of rounds 2 and 3: at most 330 ms with 50 names;
- the 21 round-4 shapes: at most 1,142 ms with 50 names (the Urdu phrase کا باشندہ repeated; 958 ms with none);
- the 20 round-5 shapes: at most 400 ms with 50 names (مقیم repeated); the joined-email runs 40 to 136 ms;
- U+FDFA × 100,000: 1.9 s with no names, 3.3 s with 50;
- the largest heap growth over a case: 54 MB.

The bound tests (the round-2 matrix with the round-5 cues, the round-3, round-4 and round-5 shapes; 395 tests) pass at 1.5 s per input; the joined-email rows also stay under 256 MB of heap growth.

**Changed earlier expectation:** "the wife of a Pakistani national residing abroad" counts by ruling R5-2 (mutant U13's rule removed), in `tests/f15-r4-residual.test.ts` and as round 3's fresh line 49 in `tests/f15-r3-residual.test.ts`.
