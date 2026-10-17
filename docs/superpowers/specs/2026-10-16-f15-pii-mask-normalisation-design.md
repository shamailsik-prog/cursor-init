# F15: PII mask on a normalised detection view, with an independent residual check

Date: 2026-10-16. Base: `origin/main` @ 0844ed8. Status: approved by the remediation builder under the owner's standing autonomy instruction (brainstorming self-approved and recorded here). The orchestrator's design rulings are kept as numbered rulings below; where the evidence required a refinement, the ruling says what changed and why.

Audit sources:
- `docs/audit/2026-10-13-forensic-audit.md` F15 (:397) and the threat row (:985).
- `docs/audit/REMEDIATION.md`: rule 2 (closed = merged PR with an end-to-end test of a real user flow, RED before and GREEN after), rule 3 (ticked only after an independent re-audit). This document claims neither closure nor a tick.

Scope: the shared mask (`platform/p1/maskOutboundPII.ts`), a new normaliser (`platform/p1/piiText.ts`), a new residual detector (`platform/p1/residualPII.ts`), the rank >= 3 check (`platform/p1/providerPolicy.ts` `assertMinimised`), the Functions gateway and committeeBrain (`functions/src/p1/gateway.ts`, `functions/src/p1/ops.ts`), and their docs. Not touched: `platform/http/withSession.ts`, `platform/p5/session.ts`, `platform/persistence/adminFirestore.ts`, `platform/persistence/firestoreSpineRepositories.ts`, `platform/p5/committeeScope.ts`, `platform/p5/insecureDevAuth.ts` (PR #44), and `app/api/**`.

## 1. Root cause, traced from the code

`maskOutboundPII` (`platform/p1/maskOutboundPII.ts:28-36, 42-107` on main) runs eight ASCII regexes (`\d`, `[.\-\s]`, `\b`) over the raw text, then each supplied party name as a literal, case-insensitive regex (`:85-93`). Three consequences:

1. **Unicode identifiers are invisible.** `\d` matches only U+0030-0039. A full-width CNIC (`３５２０２－１２３４５６７－１`, U+FF10-FF19 and U+FF0D), an Urdu-digit mobile (`۰۳۰۰-۱۲۳۴۵۶۷`, U+06F0-06F9), an Arabic-Indic or Devanagari number, or a CNIC with zero-width spaces (U+200B) between its digits matches none of the patterns. The audit's synthetic full-width CNIC and Urdu phone produced zero redactions.
2. **Names match only as typed.** `new RegExp(escapeRegExp(name), "gi")` matches the exact code points with ASCII case folding. `TARIQ  ZARVANI` (two spaces), `Tariq\u00A0Zarvani` (NBSP), `طارق زروانی` written with Arabic yeh (`ي` U+064A) instead of Urdu yeh (`ی` U+06CC), or with harakat, all survive. Names come only from `matter_parties` rows and the request (`functions/src/p1/ops.ts:210-223`); the matter's client record is not read.
3. **The assurance is the same detector.** `assertMinimised` (`platform/p1/providerPolicy.ts:132-141`) re-runs `maskOutboundPII` on the masked text and passes when it finds nothing. Anything the mask cannot see, the check cannot see either. An address (`r/o House 12, Street 5, Lahore`), a parentage clause (`s/o Kamran`), a landline, or a ten-digit number without the mobile prefix passes the rank 3 and rank 4 obligation unchanged, and the provider policy then lets the call out.

Masking cannot be proof of anonymity: a name the firm never recorded, written in free prose, or a semantic fact ("the only female sessions judge in the district") has no pattern. The correction makes the mask see what it claims to see, widens the authoritative name source, and adds a second, different detector whose findings block privileged export and are recorded on every call.

## 2. Design rulings

### Ruling 1: a normalised detection view with an index map

`detectionView(text)` (`platform/p1/piiText.ts`) builds a detection string and, for each of its UTF-16 code units, the start and end offsets of the original code point it came from. Per original code point, in this order:

| Input | Detection output |
| --- | --- |
| `\p{Cf}` (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, LRM/RLM, bidi embeddings and isolates U+202A-202E and U+2066-2069, soft hyphen U+00AD, BOM U+FEFF, Arabic letter mark U+061C, ...) | dropped (nothing) |
| anything else | its NFKC form (full-width ASCII becomes ASCII, `①` becomes `1`, `₨` becomes `Rs`), then per character of that form: |
| `\p{Nd}` (any script's decimal digit, including Arabic-Indic U+0660-0669, Extended Arabic-Indic U+06F0-06F9, Devanagari, Bengali, mathematical digits) | its ASCII digit |
| `\p{Pd}` or U+2212 MINUS SIGN | `-` |
| `\p{Zs}` (NBSP U+00A0, U+2000-200A, U+202F, U+205F, U+3000, U+1680) | a space |

Each detection unit maps to the whole span of the original code point that produced it; an NFKC expansion gives several units the same span. Dropped characters have no unit, so a match whose first and last units straddle them covers them in the original.

- **Digit value.** JavaScript has no API for a digit's numeric value. Unicode's stability policy assigns `Numeric_Type=Decimal` characters only in contiguous ascending runs 0 to 9, so the value is `(cp - runStart) % 10`, where `runStart` is the first code point of the maximal `\p{Nd}` run containing `cp`. Verified on Node 22.22 (the Functions runtime): 72 maximal runs, every length a multiple of 10 (the two longer runs, U+116D0 and the mathematical digits at U+1D7CE, are 20 and 50 long). Values are memoised.
- **Dash set (refinement).** The orchestrator's list was U+2010-2015, U+2212, U+FE58, U+FE63, U+FF0D. NFKC already maps U+FF0D and U+FE63 to `-` and U+FE58 to U+2014. The implementation maps all of `\p{Pd}` plus U+2212, a superset: this is a detection-only view, so mapping more dash forms can only let separator-based patterns match more, and never changes text outside a match.
- **Line breaks and tabs** are not `Zs` and stay as they are, as on main (`\s` in the patterns already accepts them).

### Ruling 2: one pass, matches replaced in the original

Every mask pattern runs on the detection view, in main's priority order (CNIC separated, CNIC plain, mobile in brackets, mobile, email, IBAN, NTN, passport), then the party names (ruling 3). A match maps back to the original span `[start of its first unit, end of its last unit)`. Each accepted match blanks its units (and any unit sharing its original code points) with U+E000 in the view, so a later pattern never matches inside an earlier match. The output is the original text with each accepted span replaced by its token (`[CNIC]`, `[PHONE]`, `[PARTY]`, `[EMAIL]`, `[IBAN]`, `[NTN]`, `[PASSPORT]`); every unmatched code unit of the original is kept exactly, including zero-width characters outside matches. Two matches that map to overlapping original spans (possible only inside one NFKC expansion) are merged into the earlier token. Counts are per match, by the same kinds as main.

- **Re-run semantics unchanged.** Tokens already present in a text are not protected: a party named `Party` still matches inside `[PARTY]` when the masked text is masked again, so `assertMinimised` still fails closed for it. The existing test `functions/test/p1.gateway.emu.test.ts` "a privileged call whose masked text would still be masked again is blocked not_minimised" relies on this, and it stays as it is.
- **Patterns unchanged, except EMAIL's anchor.** Seven regexes are main's; only what they run on changes. EMAIL (main `\b[A-Z0-9._%+-]+@...`) restarted at every word boundary inside a run of local-part characters and backtracked over the rest of the run each time: measured on Node 22, a 32,000-character run of `1-` took 1.25 s and 100,000 characters (the body cap) about 12 s, per mask call. It is now anchored at the start of such a run (`(?<![A-Z0-9._%+-])`), which matches every address main matched (it may take one more leading `-`, `.` or `_`, over-masking by one character) and runs in linear time. Found by this finding's 100,000-character bound test; recorded here because it is in the code this finding rewrites. No landline or address rule is added to the mask (§5).
- **Measured cost.** Mask plus residual check on adversarial 50k / 100k / 200k-character inputs (label runs, separator runs, digit runs, repeated cues, Urdu prose, long names): linear, at most about 0.2 s per 100,000 characters on the builder's machine.

### Ruling 3: party names on a folded view

The name view is derived from the (blanked) detection view, unit by unit: lower-cased; NFD with every `\p{M}` removed (Latin diacritics, Arabic harakat U+064B-065F, superscript alef U+0670, the hamza and madda that NFD splits off `أ إ آ ؤ ئ ۂ`); tatweel U+0640 dropped; Arabic letter variants folded: `ي` U+064A and `ى` U+0649 to `ی` U+06CC; `ك` U+0643 to `ک` U+06A9; `ة` U+0629, `ۃ` U+06C3, `ه` U+0647 and `ە` U+06D5 to `ہ` U+06C1. Each supplied name gets the same fold; its whitespace runs become `\s*` in the pattern, so `TARIQ  ZARVANI`, `Tariq\nZarvani` and `TariqZarvani` all match `Tariq Zarvani` (Urdu often writes compound names joined).

- **Not folded:** `ھ` U+06BE (do-chashmi he marks aspiration, a different letter) and `ے` U+06D2 (yeh barree, a different letter at word end).
- **Substring semantics kept.** Main matched a name anywhere, even inside a longer word. That over-masks (a name `Ali` masks inside `quality`) but never under-masks; the fold widens it only in the safe direction. No word-boundary rule is added.
- **Longest first inside the mask.** Folded names are de-duplicated and sorted longest first (ties in code-unit order) by `maskOutboundPII` itself, so every caller (Functions gateway, Next legacy caller, eve tools, translate) gets it, not only committeeBrain.
- **No auto-NER.** Capitalised words that are not supplied names are never masked (main's header reason stands).

### Ruling 4: names from the matter's client record

The Functions data model links a client to a matter: `openMatterOp` writes `clientId` on the matter (`functions/src/d1/matter/ops.ts:295`) and `registerClientOp` writes `canonicalName`, and optionally `companyName` and `concernedPersonName`, on `clients/{clientId}` (`functions/src/d1/client/ops.ts:101-118, 168-180`). The `matter_parties` client row holds the conflict-check subject's spelling, which can differ from the client record's. `partyNamesFor` now also reads `clients/{matter.clientId}` and adds those three names when the record exists and belongs to the caller's firm. The read runs in parallel with the `matter_parties` query, so committeeBrain's pre-call path (`PRE_CALL_ALLOWANCE_MS`, eight round trips) gains no sequential round trip. The client record's identifiers (`cnic`, `primaryMobile`, `alternateMobile`, `email`, `address`) are not added as literals: the ruling's scope is names, and the patterns plus the residual check cover the identifier shapes. Recorded as residual risk.

### Ruling 5: an independent residual detector

`residualPII(text)` (`platform/p1/residualPII.ts`) runs on the detection view of already-masked text and returns counts by kind, never text. Its method differs from the mask's: the mask recognises specific identifier formats; the residual detector scans every digit run by its length and grouping, and looks for the contextual cues Pakistani legal prose uses before identifying content. Mask tokens are recognised so that masked content does not count.

| Kind | Fires on | Refinements (each a recorded false-positive class, with a test) |
| --- | --- | --- |
| `id_digits` | a run of digit groups joined only by single separators from [space, `-`, `.`, `/`] (invisible characters are already dropped), totalling >= 10 digits. Commas and every other character end a run. | Not when preceded by a currency marker (`Rs`, `Rs.`, `PKR`, `USD`, `US$`, `$`, `روپے`; `₨` is `Rs` after NFKC) **or followed by** `/-`, `روپے` or `rupee(s)`: Urdu writes the unit after the amount, and `/-` is the Pakistani amount suffix. Not when every group is <= 3 digits or a year 1900-2099 (section lists such as `302/324/148/149 PPC` are 12 digits). Not when it is exactly two groups joined by `/` and the second is a year (case numbers such as `123456/2021`). |
| `labelled_identifier` | an identity or contact label (`CNIC`, `NIC`, `N.I.C`, `C.N.I.C`, `ID card`, `identity card`, `شناختی کارڈ`, `passport`, `پاسپورٹ`, `mobile`, `cell`, `phone`, `telephone`, `tel`, `موبائل`, `فون`, `email`, `e-mail`, `ای میل`), then at least one separator (`:`, `#`, `-`, `No.`, `No`, `Number`, `نمبر`), then a value that is not a mask token | The value must contain `@` or at least 3 digits (the first token, plus following tokens while they are digit groups), except after an email label, where any letter or digit counts. Without this, `cell No. 4` (a jail cell) and `phone - he said` would block. |
| `address` | `r/o`, `ساکن`, `سکنہ`, and `address` or `پتہ`/`پتا` followed by `:` or `-`, each followed by content that is not a mask token; `resident(s) of` followed by a proper noun or a number; `house` (optionally `No.`, `#`, `Number`), `H.` with `No.`/`#`/`Number`, or `مکان نمبر`, then a number; `street`, `gali`, `گلی`, `mohallah`, `mohalla`, `محلہ` (optionally `No.`/`#`/`نمبر`), then a number | `resident of Pakistan` / `ساکن پاکستان` is not an address: it is the standard petition boilerplate ("citizen and resident of Pakistan") and names no place smaller than the country. `resident(s) of` (unlike `r/o`, which only ever precedes an address) is ordinary English: `the residents of the area chased the accused` names no one. After it, up to five locative words (`the`, `said`, `same`, `village`, `town`, `city`, `district`, `tehsil`, `mohallah`, `chak`, `colony`, `sector`, `block`, `house`, `street`) are passed over, and it counts when the next word starts with a capital, a digit or an Arabic-script letter: `resident of the village Kot Qalvo` counts, `resident of the area` does not. |
| `kinship_name` | `s/o`, `d/o`, `w/o`, `son of`, `daughter of`, `wife of`, `widow of`, `ولد`, `بنت`, `زوجہ`, `دختر`, then (after an optional `the`, `late`/`(late)`/`مرحوم` and title `Mr`, `Mrs`, `Ms`, `Mst`, `Dr`, `Ch`, `Sh`) a name that is not a mask token | A Latin name must start with a capital letter (`the son of the deceased` does not count), except after `s/o` and `d/o`, which are unambiguous abbreviations and take any word. `w/o` also abbreviates "without" and needs a capital. An Arabic-script word always counts. `the` is passed over so that `son of the late Kamran` reaches the name; `son of the deceased` then reaches `deceased`, which has no capital. Titles that are also names (`Malik`, `Rana`, `Syed`) are not skipped, so they count as the name. |

Two test tables pin it: a true-positive table for every kind in English and Urdu (Urdu digits included), and a false-positive corpus of ordinary Pakistani legal prose (dates, FIR and case numbers, citations such as `PLD 2019 SC 123` and `2020 SCMR 456`, section lists, amounts with commas and with `/-`, `the son of the deceased`, `resident of Pakistan`, Urdu prose with Urdu digits) that must produce zero findings.

### Ruling 6: the rank >= 3 obligation

`assertMinimised(request, partyNames)` passes only when, for the masked body and the masked purpose, a mask re-run finds nothing **and** `residualPII` finds nothing. The block reason stays `not_minimised` (no new `BlockReason`; the enum, the README table and the tests keep their lists). Which ranks carry the obligation is unchanged: L18 §4.6 (`providerAllowedFor`), ranks 3 and 4 only. A rank 0 to 2 call is not blocked by residual findings; they are recorded (ruling 7).

### Ruling 7: residual counts recorded beside the redaction counts

`callP1` computes `residualCounts` (all four kinds, zeros included) on the masked body, next to `redactionCounts`, on every call, blocked or not: `P1Result.outbound.residualCounts`. From there it reaches, unchanged:
- `committee_outputs.outbound.metadata.residualCounts`;
- the F09 attempt receipt on the operation's marker (`result.outbound.residualCounts`). `receiptOf` validates it like `redactionCounts` when present and tolerates its absence, so a receipt written by a pre-F15 instance still resumes, and its row simply has no residual counts.

Not recorded on `ai_usage_logs`: like `redactionCounts` on main, the accounting row carries no content-derived fields. Firestore rules: `committee_outputs` is server-write-only (`allow write: if false`) with no field schema, and no rule constrains the marker's `result`, so `firestore.rules` needs no change. The Next `CommitteeBrainOutput` type (`platform/spine/store.ts:1910`) is not changed: Next reads these rows through an unchecked cast (`getById<CommitteeBrainOutput>`) and never writes the field.

### Ruling 8: the Next legacy caller

`platform/p1/internalAICaller.ts` (the Next route, F18, to be retired by O-53) inherits the normalised mask, the folded names of ruling 3 (for the names it is given; it does not read the client record), and the stronger `assertMinimised` with no code change; its rank >= 3 refusal text is unchanged. It does not record residual counts: its persisted output goes through `firestoreSpineRepositories.ts`, which PR #44 holds. `platform/p1/eveTools.ts` `maskPreview` and `platform/p1/translate.ts` get the new mask unchanged.

### Ruling 9: documentation states what masking is

The mask module header and `functions/src/p1/README.md` say plainly that masking reduces risk and is not anonymisation, and list what it still does not catch: names the firm never recorded, in free prose; semantic identifying facts; addresses and parentage without a cue (and, at ranks 0 to 2, even with one: they are counted, not masked); identifiers spelled out in words or with look-alike letters (`O3OO` for `0300`); digit groups joined by multi-character separators (`0300 - 123 - 4567`).

## 3. Data flow after the change

```
committeeBrain ─ partyNamesFor: matter_parties ∥ clients/{matter.clientId}
   └─ callP1
        ├─ maskOutboundPII(body), maskOutboundPII(purpose)   (detection view, name view, one pass)
        ├─ residualCounts = residualPII(masked body)          (recorded on every call)
        ├─ providerAllowedFor → rank ≥ 3 → assertMinimised   (mask re-run + residualPII on body and purpose)
        │       └─ any finding → blocked not_minimised; the transport is never called
        ├─ transport.send(masked body) → maskOutboundPII(response)
        └─ P1Result.outbound { body, purpose, redactionCounts, residualCounts }
              ├─ F09 receipt on the marker
              └─ committee_outputs.outbound.metadata
```

## 4. Tests

- `tests/f15-detection-view.test.ts`: the view and its index map (full-width, Arabic-Indic, Extended Arabic-Indic, Devanagari and mathematical digits, dash and space variants, zero-width characters inside a CNIC, NFKC expansions, surrogate pairs), and the name fold.
- `tests/f15-mask-unicode.test.ts`: the mask through its public API only (so it runs, and fails, against main): the audit's counterexample, every digit script, invisible characters, unmatched text kept byte for byte, party-name variants (case, spacing, NBSP, Arabic letters, harakat, Latin diacritics), longest first, and the `assertMinimised` truth table.
- `tests/f15-residual-pii.test.ts`: the true-positive table per kind (English and Urdu), the false-positive corpus, counts-only output, and a 100,000-character adversarial input bound (no catastrophic backtracking).
- **Closing e2e** `functions/test/f15-pii-mask.e2e.emu.test.ts`, through the real `committeeBrain` HTTP route (`viaApi`, the router, Auth and Firestore emulators) with a capturing transport at the `setP1TransportForTests` boundary:
  - (a) the audit's counterexample (full-width CNIC, Urdu-digit mobile, CNIC split by zero-width spaces) never reaches the transport, and the stored `committee_outputs` row shows `redactionCounts` (2 CNIC, 1 phone) and `residualCounts`;
  - (b) a `matter_parties` name written in the body with different case and spacing, and its Urdu spelling with Arabic letter variants, is masked;
  - (c) a privileged matter (provider configured with an executed DPA) whose body carries `r/o House 12, Street 5, Lahore` or `s/o Kamran` is blocked `not_minimised` and the transport is never called;
  - (d) the matter's client record name (not in `matter_parties` and not supplied) is masked; (d') another firm's client record is never read;
  - (e) the F09 resume path: a receipt with residual counts publishes them; a receipt recorded before F15 (none) still resumes and its row has none; a receipt with malformed residual counts is not published (409 `idempotency_effect_committed`, no second provider call).
- Changed exact-shape assertions: `functions/test/p1.gateway.emu.test.ts` and `functions/test/p1.api.emu.test.ts` list `outbound` / `outbound.metadata` keys exactly; they now include `residualCounts` with its expected zeros. No assertion is loosened.

Fixtures use only invented names (Qalvo, Nura, Tariq Zarvani, Haris Qalbani, Omer Daryani, Kamran as a bare given name) and synthetic numbers.

## 5. Residual risk (stated, not closed)

- **Not anonymisation.** Names the firm never recorded in `matter_parties`, the client record or the request; semantic identifying facts; free-text addresses and relationships without a cue; identifiers written in words or with look-alike letters; separators the patterns do not list. At ranks 0 to 2 the residual findings are counted, not masked or blocked.
- **Human review is not built.** L18 §4.6 / L17.13a/h's partner-authorised exception (with a recorded reason) and the deterministic-only path remain `TODO(firm)` (`providerPolicy.ts`). A residual finding at rank 3 or 4 is a hard block with no override; there is no high-risk review queue.
- **False positives block privileged calls.** Measured on held-out prose (R3-6): 2 of the re-auditor's 60 held-out fresh lines and 1 of 134 new lines written before the round-3 code were flagged, 3 of 194 (1.5%); all four corpora now pass as regression rows. The cue rules still rest on word lists (stop words, role nouns, verbs after a role, adjectival collocations), and prose outside them can block a rank 3 or 4 call `not_minimised`. That fails closed. Known: an amount of 3 billion rupees or more written as one bare run of ten or eleven digits starting with 3 counts as a mobile without its prefix (R3-7).
- **Known false negatives (R2-5, R3, recorded).** The following still pass:
  - obfuscated emails without a label (`nura [at] qalvo [dot] pk`);
  - identifiers in words (`zero three zero zero one two three ...`, `CNIC three five two zero two`, `house number twelve`);
  - a CNIC or licence label with four digits (`CNIC No. 3520`, `Licence No. 1234`): below the label minimums (R2-3e);
  - `ولد کا کامران` (a stop word between the cue and the name: `ولد کا نام` is ordinary prose) and `بن کامران` (R2-3a);
  - an email that runs into a recorded name (`...@0.TTariq Zarvanix4-p`): the email pattern takes the name's first letters, and the rest of the name no longer matches (R3-8);
  - mobiles without a prefix (`300-1234567`) and `0300/1234567` (a slash without whitespace, R3-2): the residual check counts them, so rank 3 and 4 block, but below rank 3 they leave;
  - vehicle registration and chassis numbers;
  - dates of birth, age, caste and other semantic facts;
  - a recorded name written only in part (a surname) or reversed (`Zarvani, Tariq`), or broken by a hyphenated line break;
  - `the deceased's widow Nura` (a kinship word without `of`);
  - `resident of the village` followed by a lower-case or no name.
- **Cost of long NFKC expansions (R2-2).** 100,000 copies of U+FDFA (18 characters each in NFKC) cost 1.8 s of rank-3 work with no names and 3.0 s with 50 names (measured at the round-3 head), under the 8 s pre-call allowance. More names cost more.
- **Homoglyphs.** Cyrillic and Greek Latin look-alikes are folded (R2-5); look-alikes from other scripts (Armenian, Cherokee, mathematical letters outside NFKC) are not.
- **A dropped invisible character can remove a word boundary.** `CNIC\u200B3520212345671` becomes `CNIC3520212345671` in the detection view, and the CNIC pattern's leading `\b` no longer holds, so the mask misses it (as main did for the ASCII form `CNIC3520212345671`). The residual detector still counts the 13-digit run, so a rank 3 or 4 call is blocked; below rank 3 it is counted, not masked. A grouped form glued to a label (`CNIC\u200B35202-1234567-1`) is masked since round 3, by the grouped CNIC pattern (R3-7).
- **Client identifiers as literals.** The client record's CNIC, mobile, email and address are not used as literal masks (ruling 4).
- **Next legacy path** records no residual counts (ruling 8).
- **Classification is still the gate.** A privileged text mislabelled `internal` is masked and counted, not blocked: the audit's mislabelling scenario is reduced (the counterexample's identifiers are now masked) but not eliminated.

## 6. Alternatives rejected

- **NER for names.** Rejected (main's header): masking every capitalised word destroys legal prose and still misses Urdu names.
- **Normalising the outbound text itself** (sending the NFKC form). Rejected: it changes text the firm wrote outside any identifier; the view-and-map approach keeps unmatched text exactly.
- **A new `BlockReason` (`residual_pii`).** Rejected: the obligation is the same L18 §4.6 minimisation; the residual counts on the output row say why.
- **Masking residual findings.** Rejected for this finding: the cues are context, not identifier formats, and masking text after `s/o` or `r/o` blindly would replace the wrong span as often as the right one. They block where the obligation applies and are counted elsewhere.

## 7. Re-audit round 1 (FAIL 6/10): rulings R2-1 to R2-6

The independent re-audit of PR #61 at 4f0e2b7 (plus the receipt fix 92cf971) failed the finding at 6/10: one HIGH and three MEDIUM blocking defects, LOW items and INFO notes. The coordinator's rulings are recorded below as R2-1 to R2-6, each with its reason. Where a test showed a better rule, the refinement and its reason are recorded with the ruling. The re-auditor's attack inputs are regression rows:
- `tests/f15-r2-mask.test.ts` and `tests/f15-r2-residual.test.ts`;
- `tests/f15-r2-corpus.ts`, which holds the 126-line false-positive corpus verbatim;
- `tests/f15-r2-bounds.test.ts`;
- the e2e rows (f) to (h).

### R2-1 (HIGH-1): every invisible character, not only `\p{Cf}`

**Finding.** Characters that are not format characters defeated both detectors end to end at the privileged rank. Examples: the combining grapheme joiner U+034F, variation selectors U+FE00-FE0F and U+E0100-E01EF, Mongolian U+180B-180D, Hangul fillers U+115F/U+3164/U+FFA0, Khmer U+17B4/17B5, U+2065, U+FFF0-FFF8, combining accents, U+0332 (underline) and U+20E3 (keycap). A CNIC with U+034F between its digits was sent to the provider with 13 digits.

**Ruling.** The detection view drops every `\p{Default_Ignorable_Code_Point}` and every `\p{M}`, as well as `\p{Cf}`, and keeps the index map. This applies before NFKC and to each character NFKC produces.

**Refinement.** A match's original span is extended over the combining marks that follow its last character. A keycap or an accent on the last digit would otherwise be left dangling after the token. Marks attach to the previous character, so this takes nothing that belongs to the next one. Default-ignorables that are not marks, such as a direction mark, are not swallowed: round 1's test keeps an RLM after `[CNIC]`.

The mask header and the README now list exactly what is dropped.

### R2-2 (MEDIUM-2): linear time on every input

**Finding.** `NUMBERED_PLACE` contained `house\s*(?:no\.?|number|#)?\s*\d`. Two whitespace quantifiers around an optional group split every whitespace run in O(n²) ways per start. A cue followed by 100,000 spaces took 12.8-20.4 s, and committeeBrain answered 503 `precall_deadline`.

**Ruling.**
- Every regex is restructured so that no two whitespace quantifiers meet around an optional or repeated part; the optional part now carries its own leading whitespace.
- Every residual cue regex is generated from the word lists exported as `RESIDUAL_CUES`, and the mask exports `MASK_CUES`.
- Every mask separator quantifier is bounded (`{0,3}`, or `{1,3}` for the CNIC).

**Audit of every regex.**
- *Mask:* CNIC (`[.,/\-\s_]{1,3}`, was `+`), the IBAN (`[\s-]{0,3}`, was `\s*`), the mobile, UAN and landline patterns (bounded), EMAIL (anchored, round 1), NTN and passport (bounded separators), and names (`tok\s*tok`, required tokens between).
- *Residual:* every regex reads either the whole text with fixed-shape alternations, or a window of at most 80 characters.

**Bound test.** Every cue of both lists (175 cues) is followed by 100,000 characters of each of eight fillers: space, tab, newline, NBSP, `.`, `-`, `#` and `7`. Each input runs through rank-3 work: the mask, the residual check, and `assertMinimised`'s mask re-run and residual check, with three party names. The bound is 1.5 s per input.
- The worst cue takes 0.99 s for all eight inputs, about 0.12 s each.
- The re-auditor's six inputs take 45-151 ms; before the fix they took 24.4-42.1 s.

**Speed.** ASCII text, and ASCII runs inside other text, take a fast path in `detectionView`. The units of a view are re-joined only after a match changes them.

**Not closed.** One code point whose NFKC form is long (U+FDFA expands to 18 characters), repeated 100,000 times, costs 1.6 s of rank-3 work with no names and 2.7 s with 50 names (measured at the round-2 head). That is under the 8 s pre-call allowance. Recorded in §5.

### R2-3 (MEDIUM-3): false positives on clean privileged prose

The re-auditor's 126-line corpus is a must-pass test. Two lines are true positives under the rulings below, and `RULED_TRUE_POSITIVE` names each with its reason:
- "a resident of Lahore" (R2-3c);
- "the son of the deceased Kamran" (R2-3b).

Result: 124 of 124 clean lines pass, a false-positive rate of 0%. Round 1's own corpus (36 lines) and the 37 new row-by-row cases also pass, also 0%.

**a. Urdu cues.**
- *Ruling.* ولد, بنت, زوجہ, دختر, ساکن, ساکنہ, سکنہ, رہائشی, پسر and بیوہ count only when the next word is not on the Urdu stop list. The list holds the coordinator's function words, postpositions and auxiliaries, plus ہو, ہوا, ہوئی, ہوئے, رہا, رہی, رہے, تک and لیے.
- *Refinement 1.* Urdu legal role and heir nouns do not count: قانونی, شرعی, وارث, نابالغ, مدعی, ملزم, مقتول, گواہ and the like. The reason is the corpus line "متوفی کی زوجہ اور دختر قانونی وارث ہیں": "the daughter's legal heirs" names no one, just as an English role does not (R2-3b).
- *Refinement 2.* ساکن followed by پانی, جائیداد, جائداد, حالت or ہوا is the adjective "still" or "immovable", not "resident" (corpus lines "ساکن پانی میں…" and "یہ ساکن جائیداد ہے…").
- *Refinement 3.* The idiom بنت حوا ("daughter of Eve", meaning "a woman") does not count.
- بن is not a cue: in Urdu it is the everyday verb "become".

**b. English kinship cues.**
- A party-role reference after the cue never counts as the name. The roles are Respondent, Petitioner, Appellant, Accused, Complainant, Plaintiff, Defendant, Applicant, Deceased, Witness, PW, DW, Opposite Party and the like, optionally followed by `No.` and a number.
- After an honorific title (Mr, Mrs, Ms, Mst, Dr, Ch, Sh, late), any word is the name, lower case too: "son of Mr. omer" counts.
- *Refinement 1.* After a role word, only a capitalised word is a name. The ruling placed "the deceased" with the titles that accept any word, but the corpus line "The son of the deceased appeared as PW-1" must pass. With this rule, "son of the deceased Kamran" and "wife of the accused Kamran Qalvo" count, while "…deceased appeared" and "…complainant deposed" do not.
- *Refinement 2.* Name-titles (Malik, Syed, Mian, Haji, Chaudhry, Rana and the like) are skipped before a name, but count as the name when no name follows. "son of Malik was arrested" still counts, because Malik is often the surname.
- *Refinement 3.* Shaheed and Martyr are role words (corpus line "The widow of Shaheed was granted compensation").

**c. Singular residence cues.**
- Singular `resident of`, `r/o` and the Urdu cues count before any following word that is not a function word, lower case included: "resident of lahore" counts, and so does "a resident of Lahore" (a true positive).
- *Refinement.* After "the" (or "the said"), a place noun followed by a capitalised word or a number still counts. This keeps round 1's true positive "resident of the village Kot Qalvo". "the said house for twenty years", "the Province of Punjab" and "the village came forward" still pass.

**d. Plural.** `residents of` is exempt: "Residents of Karachi suffered from load shedding" names no one.

**e. Label minimums.**
- *Ruling.* Phone labels (cell, mobile, phone, telephone, tel, موبائل, فون) need 7 or more digits. CNIC, NIC and ID-card labels need 5 or more. NTN needs 7 or more. A passport needs an alphanumeric token of 7 or more characters with a digit.
- *Refinement 1.* An email label needs an address-like value: `@`, a handle such as `a.b`, or "x at y". The reason is the corpus line "Email - see the annexed print-outs."
- *Refinement 2.* Driving and other licence labels (licence, license, لائسنس) need 5 or more digits, from the re-auditor's false-negative line "Driving licence No. 12345678".
- Round 1's six-digit Urdu phone row now uses seven digits; six digits now pass, and that is pinned.

**f. The address label.** `address:` (or پتہ / پتا with `:` or `-`) counts only at a field start: the start of the text or a line, or after `|`, `;`, `,`, `(` or `[`. It also counts after permanent, present, postal, residential, home, office, mailing, current, business, correspondence or registered. "Counsel will address: …" passes.

**g. Numbered places.**
- *Ruling.* A number followed by a unit word does not count: years, months, days, marla, kanal, acre(s), feet, metres, rooms, storeys, residents, persons and the Urdu units.
- New cues: Plot, Flat and Shop need `No.`; Apartment counts with a bare number.
- *Refinement.* A bare number (no `No.`) counts only before punctuation, the end of the text, a place cue (optionally after and, & or or), or a proper noun. The reason is the corpus line "The House 2 of the Senate committee met", which has no unit. Round 1's "Street No. 9, Gali 4 and Mohalla 3." still counts three.

**h. id_digits exemptions.**
- *Ruling.* An amount ending in `/=` or `/-` is exempt. So is a document number after Diary, FIR, Case, Suit, Appeal, Petition, Reference, Challan or Complaint with its `No.` (the `No.` is required), and a group after a land-record cue (khasra, khewat, khatooni, mutation, intiqal, murabba, killa and their Urdu forms).
- *Refinement.* A currency word after a parenthetical is exempt ("2500000000 (two billion …) rupees"), and so is an amount word before the run ("An amount of 1500000000"). Both are corpus lines.

### R2-4 (MEDIUM-4): real formats are masked at every rank

**Mobiles.**
- *Ruling.* A +92, 0092, 92 or (0 prefix, brackets allowed, then 3 and nine digits in any grouping, with up to three separator characters between groups. Separators are whitespace, `.`, `,`, `-`, brackets and `_`. This covers `0300 - 1234567`, `+92 300 123 2019`, `03 00 12 34 567` and `(+92) 300-1234567`.
- *Refinement.* `/` is not a mobile separator: "03/01/2021 123" is a date and a number.

**Landlines and UANs.**
- Landlines: an area code (0 and two to four digits, bracketed or not, or +92 / 0092 and one to three digits), then six to eight digits.
- UANs: 111 and six digits, with an optional area code.
- The IBAN pattern now runs before the phone patterns, so its digit groups are never read as a phone.

**NTN and passport.**
- NTN: `NTN No.`, `N.T.N`, `N.T.N.`, with an optional check digit.
- Passport: `Passport No. AB1234567` is masked whole.
- IBANs with dashes are masked.

**Residual.**
- *Ruling.* A run starting with 0 or 92 (a `+` before it is outside the run) with 10 to 13 digits keeps no exemption.
- *Refinement.* A run that starts with a date ("01.02.2021 10.30") is not mobile-shaped, whatever its first digit.

**False-positive guard.** The mask leaves all 126 corpus lines unchanged. Six further prose rows with citations, dates with times, a date followed by a case number, amounts, sections with a leading zero and an FIR stay unmasked too.

### R2-5 (LOW): fixed

- **Name view.** Cyrillic and Greek Latin look-alikes are folded. ھ is folded to ہ: this reverses round 1's note in ruling 3, because a name written with either letter is the same name and folding only adds matches. Full stops are dropped. Underscores and hyphens read as spaces. A recorded name that starts with an honorific (Mr, Mrs, Ms, Mst, Miss, Dr) is also matched without it.
- **Emails.** Local parts and domains of any script (`\p{L}\p{N}`).
- **Passports.** An unlabelled `[A-Z]{2}\d{7}` is masked, case-sensitive.
- **Digits.** Enclosed and dingbat digits map to their numbers: U+2460-24FF and U+2776-2793, including the parenthesised and full-stop forms that NFKC turns into "(1)" and "1.". Round 1's span test used U+2474 and now uses U+FB01.
- **Separators.** U+066B and U+3002 map to `.`; U+066C and U+060C map to `,`. `_` is accepted as a separator in the CNIC, the mobile and the residual digit run.

**Recorded, not fixed** (in §5):
- obfuscated emails (`[at]`, `[dot]`) without a label;
- mobiles without a prefix (the residual check counts them);
- vehicle registration and chassis numbers;
- dates of birth and other semantic facts;
- a recorded name written only in part (a surname) or reversed;
- a name broken by a hyphenated line break.

### R2-6 (INFO)

- The e2e header now says which rows fail on main and which are guards that pass on main.
- (d′) is renamed: "another firm's client record is read by id and discarded, never used".
- Mutant M14 (party count inside one NFKC expansion) is killed by a test: `x U+FDFA y` with the names الله and صلى counts 1.

### Changed round-1 test expectations (each follows a ruling)

- `tests/f15-detection-view.test.ts`: the NFKC-expansion span test uses U+FB01, because U+2474 now maps to "1" (R2-5); the do-chashmi he assertion is now equality (R2-5).
- `tests/f15-residual-pii.test.ts`: the Urdu phone-label row has seven digits (R2-3e).

## 8. Re-audit round 2 (FAIL 7/10): rulings R3-1 to R3-8

The independent re-audit of PR #61 at 15a5385 failed the finding at 7/10. Every round-1 finding was verified fixed. The blocker was a regression that R2-2 introduced: inputs main masked reached the provider. There were also bypasses through the new exemptions. The coordinator's rulings are recorded below as R3-1 to R3-8, each with its reason; refinements a test showed are recorded with theirs. The re-auditor's inputs (`r2-mainregress`, `r2-sepregress`, `r2-smuggle`, `r2-misc`, `r2-e2e-attack`, `r2-fresh-fp`) are regression rows:
- `tests/f15-r3-mask.test.ts`: R3-1, R3-2 and R3-7, and the differential test against main's patterns;
- `tests/f15-r3-residual.test.ts`: R3-2 to R3-7, and every line of both false-positive corpora;
- `tests/f15-r3-bounds.test.ts`: the separator runs R3-1 and R3-2 unbound;
- `tests/f15-r3-fresh-corpus.ts` (the re-auditor's 120 fresh lines, split) and `tests/f15-r3-heldout-corpus.ts` (134 new lines);
- the e2e rows (i): five identifiers masked, seven clauses blocked, two clean lines allowed.

### R3-1 (HIGH, blocking): everything main masked is masked again

**Finding.** R2-2 bounded the mask's separators: `{1,3}` for the CNIC, `{0,3}` for the IBAN and the NTN and passport label gaps. Main's were unbounded. A CNIC with five spaces or four line breaks between its groups, an IBAN with four spaces, `NTN:     1234567-8` and `passport -    ab1234567` were masked on main and reached the provider at rank 3 on the branch.

**Ruling.**
- The separators are unbounded again: CNIC `[.\-\s_,/]+`, IBAN `\s*` (here `[\s-]*`, keeping round 2's dashes), NTN and passport label gaps `[:\s\-#.]*`.
- They are linear because each separator class is disjoint from the digits after it: a run is consumed once and given back once per start.
- Proof:
  - the bound test (below);
  - every main-masked input of `r2-mainregress` and `r2-sepregress` is a must-mask row;
  - the e2e rows: a privileged CNIC with five spaces, a CNIC wrapped over a line and indented, and an IBAN with four spaces;
  - a differential test with main's patterns kept in the test file as the oracle.

**Refinement: main's patterns run first.** The first run of the differential test found inputs where a wider pattern read a different grouping than main did and left letters or digits main removed:
- a CNIC run of `., _` swallowed the 0 that opens a mobile;
- the unbounded mobile separators cut a passport number;
- the anchored email took an NTN that main's email, which needs a word boundary, left alone.

Patching each order conflict would have been a list of special cases. Instead, the mask runs in two stages:
- **Stage 1** is main's patterns verbatim, in main's order, so nothing main masked is read differently. Two changes, both only widening a match:
  - the mobiles also take the country prefix main left to their left (`+92 (300) 1234567`, `0092-300-1234567`: round 2's R2-4 rows);
  - main's quadratic email is replaced by the anchored one. It ends where main's ended (before an ASCII letter, digit or underscore) and needs a word character in its local part, as main's `\b` did. A sticky continuation catches a second email that starts exactly where the first ended, which main's `\b` restart caught.
- **Stage 2** is the wider patterns, on what stage 1 left: CNIC with `,`, `/` and `_` separators, the IBAN, NTN and passport with the R3-1 gaps, the R2-4/R3-2 mobile, UAN and landline, the wider email ending, the unlabelled passport, and the grouped CNIC (R3-7).

The NTN and passport label gap is `[:\s\-#.]*(?:(?:No|Nos|Number)(?![A-Za-z])[:\s\-#.]*)?`. The second run comes only after the required word, so the two runs never compete for the same characters (mutant M1 below shows the alternative is quadratic).

R2-2's bound on the mask's separators is withdrawn; its other parts stand.

**Differential evidence.** The committed test runs three seeds of 3,000 generated ASCII inputs (main's shapes with random separator runs, labels in random case, joined with random context). It checks that the letters and digits the mask leaves are a subsequence of those main leaves. A scratch run of 300 more seeds (900,000 inputs) found no input where the mask leaves a letter or digit main removed.

### R3-2 (blocking): mobile separators

**Ruling.** Between mobile groups: `[\s.\-:_]*`, plus `/` only when it touches whitespace (` / `, `/ `, ` /`). `0300    1234567`, `0300 / 1234567`, `0300 -- 1234567` and `0300:1234567` are masked; `03/01/2021 123` is not. The DATE_PREFIX rule stays and is pinned: "The hearing on 01.02.2021 10.30 a.m." counts nothing (mutant N41, killed: M3 below).

**Refinements.**
- Round 2's `,`, `(`, `)` stay in the class (R2-4's bracketed and comma-split formats).
- The two slash alternatives are `(?<=\s)/` and `(?<!\s)/(?=\s)`. They exclude each other, so every character of a run has one parse. Overlapping alternatives backtrack exponentially on ` / / / ...` (mutant M2 below).
- The mask carries the same date guard: `On 03.01.2021 123 accused were present` is a date and a count, not a mobile (round 2 masked it).
- The residual check reads dates off the front of a digit run and judges the rest alone. So `dated 01.02.2021 1234/2021` (r2-misc) passes, and `dated 01.02.2021 0300 1234567` still counts.

### R3-3 (blocking): a label's whole value

**Ruling.** Phone, CNIC, NTN and licence minimums count every digit of the value after the label: all digit groups up to the next letter or line end. `Mobile: 0300 / 1234567` and `Cell No. 0300    1234567` count.

**Refinement.** `email nura at qalvo dot pk`, with no separator after the label, counts as a spelled address (r2-smuggle).

### R3-4 (blocking): kinship and role parsing

**Ruling.** After a kinship cue, determiners and roles are walked past and the next word is judged.
- After `a`/`an`, no word is a name ("son of a Government servant", "an Army officer", "a Member", "a Sessions Judge" pass).
- After `one`, `said`, `late`, a title or a party role, the next word in any case is a name unless it is a function word or another role. "son of the said Kamran" and "son of one Kamran" count; "son of the deceased appeared" passes.
- Urdu: role nouns (ملزم، مدعی، متوفی، مقتول، مدعا علیہ ...) and titles (مرحوم، مسماۃ، محترمہ ...) are walked past and the next word judged. زوجہ ملزم کامران، ولد متوفی کامران، دختر مدعی کامران count; دختر قانونی وارث ہے passes.
- ہونا، ہونے، ہوں، ہوتا، ہوتی (and ہوتے) are stop words (ساکن ہونا passes).
- نیک، عورت، خاتون، محترمہ: زوجہ محترمہ passes unless a name follows محترمہ.

**Refinements.**
- *Verbs, nouns and adverbs after a role* (`EN_NOT_A_NAME`). They let "son of the deceased appeared" pass while "son of deceased kamran" counts. A lower-case word ending in -ing or -ly is not a name either. No `-ed` rule: Ahmed, Javed and Saeed end in -ed.
- *Possessives.* After a possessive role ("the deceased's friend") a capitalised word is needed.
- *Naming words.* "namely", "named", "called" and "alias" announce a name.
- *Family words and police and army ranks are roles.* "son of his father Kamran Qalvo" counts. "The widow of late Shaheed Constable was paid compensation" (fresh line 50) passes.
- *English idioms.* "son of Adam" and "daughter of Eve" are not names (fresh line 66).
- *اختر.* The ruling lists نیک and اختر as non-name followers (the idiom دختر نیک اختر). Only نیک is listed: it ends the walk, so the idiom passes. اختر (Akhtar) is a common name, and listing it would let "ولد اختر" through.
- *Urdu non-names.* Added: شادی، شدہ (fresh line 114), عدالت (fresh line 84), نامعلوم, and the number words ایک to دس except نو (held-out line 121, added after the measurement).
- *Sentence ends.* A walk stops at a sentence end, unless the full stop follows an abbreviation or an initial. The round-2 e2e guard "the son of Respondent No. 2. Draft the grounds." regressed without this and passes with it.
- *Parentage labels.* `Father's name`, `Father name`, `Husband's name`, `Parentage` and `ولدیت` (R3-5) take any word but a function word, in any case. `S/o:` is the `s/o` cue.

### R3-5 (blocking): cues and residence

**Ruling.**
- New cues: `ولدیت`, `Father's name`, `Father name`, `Husband's name`, `Parentage`, `S/o:`, and the Urdu plurals سکنائے and ساکنان.
- Plural residence: `residents of`, سکنائے and ساکنان count before a locality word and then a named or numbered place.
  - "Tariq and Haris, residents of village Kot Qalvo" and کامران و حارث سکنائے موضع قلوو count.
  - "residents of Islamabad Capital Territory governed by" and ساکنان علاقہ pass.
  - General-area heads pass: علاقہ، شہر، ملک، پاکستان، صوبہ، area, city, country, province, territory, district.
- رہائشی before علاقہ، مکان، اسکیم، کالونی، پلاٹ، منصوبہ، سوسائٹی is the adjective "residential" and passes.
- The `address` label counts anywhere when its value (after `:` or `-`) has a digit or an address word in its first 60 characters. "not known", "as given ...", "N/A", "same as above" and "as stated" pass.
- Numbered places:
  - single letters are not units ("House No. 12 M Block" counts);
  - a bare house or street number before near, opposite, behind, adjacent or beside counts;
  - a bare number before `of` and a capitalised word other than "the" counts ("Street 5 of Qalvo Town"; "The House 2 of the Senate" passes).

**Refinements.**
- *Plural cues need a place after the locality word* (a capital, a number, or `No.` and a number). "Residents of the village protested" passes.
- *General areas and provinces for the singular too.* The heads above, ضلع, and Pakistan's provinces and territories: "The petitioner is a resident of Punjab" passes (fresh line 72, which the re-auditor marked debatable). A city stays an address, as R2-3c ruled.
- *More residence forms.*
  - "a resident of Pakistan and of Lahore" goes on to Lahore;
  - "r/o in Lahore" reads past the preposition;
  - "r/o the house of Kamran Qalvo" names a place;
  - ساکن مدعی گاؤں قلوو reads past the role noun;
  - `lives at`, `resides in` and the like count before a number, a proper noun or "the (said) village Kot ..." ("He lives at 12-B Qalvo Road"), not before "a distance" or "fear";
  - a locality cue alone counts before a name ("محلہ قلوو پورہ", "Mohallah Qalvo Pura"), not before محلہ داروں (fresh line 90), nor right after a residence cue that has already counted the place.
- *The address label.* At a field start with `:` or `-`, any value counts, as R2-3f ruled. Elsewhere `as` and `is` are separators too ("his address as 12-B ..."). With no separator, the value must start with a number or name an address word in its first three words ("permanent abode 14-B ..."). `residence` and `abode` are labels.
- *Numbered places.*
  - An explicit `No.` counts whatever unit follows ("House No. 12 ft wide lane", "Flat No. 4 floor 3").
  - An explicit `No.` still needs an address-like follower, as a bare number does: units, punctuation, a place cue, a proper noun, a word of position, or "in" or "at" and a proper noun. "The complainant shifted to House No. 7 after the occurrence" passes (held-out fresh line 69, after the measurement).
  - Ranges pass ("Flat No. 4 to Flat No. 9", fresh line 68), and so does "of the" and a common noun ("Street No. 3 of the housing scheme", fresh line 70).
  - `plot` takes a bare number ("Plot 45, Sector G-9/1"); `chak` and چک need `No.`

### R3-6 (blocking): honest false-positive measurement

**Ruling.** Before any tuning:
- write a new held-out corpus of at least 80 lines, committed on its own and not edited after the measurement;
- split the re-auditor's fresh corpus, tuning on its even-numbered lines only;
- report three rates, with a target of at most 5% on held-out prose;
- only then add the held-out lines as regression rows.

**Procedure.**
1. `tests/f15-r3-heldout-corpus.ts` was written and committed first (d8d53cf), before any round-3 code change and before the fresh corpus was read: 134 lines (90 English, 44 Urdu) in FIR, plaint, judgment, bail and bond style.
2. The fresh corpus (`r2-fresh-fp.json`, 120 lines) is numbered 1 to 120 in file order. Only the even lines were read while tuning.
3. A line is a false positive if the mask changes it or `assertMinimised` refuses it.
4. The rates were measured at 76902de, the round-3 implementation before any held-out line was looked at.

| Corpus | Lines | Role | False positives at 76902de |
| --- | --- | --- | --- |
| Fresh, even lines | 60 | tuned on | 0 (0.0%) |
| Fresh, odd lines | 60 | held out | 2 (3.3%): lines 37 and 69 |
| New corpus | 134 | held out, written before the code | 1 (0.7%): line 121 |
| Both held-out sets | 194 | held out | 3 (1.5%) |

The target is met. The three lines were then fixed (c532fe4, recorded under R3-4 and R3-5), and all 254 lines are regression rows that pass.

**Disclosures.**
- While reading the header of the re-auditor's fresh-corpus test, the lines marked "debatable" were seen. One of them is odd line 71, "Both petitioners are residents of District Kasur", so it was seen before the measurement. No rule was added for it: it passes under the ruling's own general-area list ("district").
- The new corpus was written by the builder, who therefore knew its lines while implementing. No rule was added for one of them before the measurement; the failure of line 121 shows it. Its number is still weaker evidence than the re-auditor's odd lines.

### R3-7 (LOW, fixed): exemption limits, the detection view, form-box CNICs

**Ruling.**
- The amount, `Rs`, `/-`, `/=`, document-number, land-record and short-group exemptions never apply to a run of exactly 13 digits, or to ten or more single-digit groups. A 10- or 11-digit run starting 3 (a mobile without its prefix) keeps no amount, currency, document or land exemption; one starting 03, 92, 0092 or +92 already kept none (R2-4).
- The detection view maps U+2800 and U+303F to a space and drops `\p{Co}`.
- The form-box CNIC `3 5 2 0 2 - 1 2 3 4 5 6 7 - 1` counts, and is masked.

**Implementation.**
- A residual digit run may now join groups with a dash and a space on either side, so a form-box CNIC is one run.
- The mask's grouped CNIC is digit groups split by one to three spaces or dashes, kept when they hold 13 digits. Lookarounds make each match a maximal run, so a 16-digit card number is never cut to 13. It runs last: run first, it cut IBAN, NTN and passport numbers (the differential test). It also masks 4-4-4-1 CNICs. Dates, citations, section lists and year lists stay clean (`tests/f15-r3-mask.test.ts`).
- *Refinement:* an amount is one group of at most twelve digits, with two-digit paisa at most. "the sum of 1234 5678 9012 3456" and 14-digit account numbers next to "valued at" or "rupees" count (r2-smuggle).
- *Not closed:* an amount of 3 billion rupees or more, written as one bare run of ten or eleven digits starting with 3, now counts (§5).

### R3-8 (INFO)

The email next to a name stays documented (§5). With the party name "Tariq Zarvani", "...@0.TTariq Zarvanix4-p" masks as `[EMAIL] Zarvanix4-p`: the email pattern takes the name's first letters, and the rest of the name no longer matches.

### Mutants

Each of these mutants of the round-3 code fails a round-3 test, run with a hard timeout (`r3_mutants.py`):

| Mutant | Killed by |
| --- | --- |
| M1: the NTN and passport label gap as two unbounded runs around an optional `No` | the bound test, head `NTN`: 385 s for its 18 inputs, against 1.5 s per input |
| M2: overlapping slash alternatives in the mobile separator | the bound test, head `0300`: not finished within the 600 s hard timeout |
| M3 (the re-auditor's N41): dates not read off a digit run | two R3-2 rows ("01.02.2021 10.30 a.m.", "01.02.2021 1234/2021") |
| M4: the wider CNIC separators bounded to three again | three R3-1 rows (four underscores, a comma with spaces, spaced slashes) |
| M5: stage 1 (main's CNIC and mobile patterns) removed | the differential test, all three seeds |
| M6: private-use characters kept in the detection view | four R3-7 rows |

### Changed earlier test expectations

None. Round 1's and round 2's tests pass unchanged.
