# F15: PII mask on a normalised detection view, with an independent residual check

Date: 2026-10-16. Base: `origin/main` @ 0844ed8. Status: approved by the remediation builder under the owner's standing autonomy instruction (brainstorming self-approved and recorded here). The orchestrator's design rulings are kept as numbered rulings below; where the evidence required a refinement, the ruling says what changed and why.

Audit sources:
- `docs/audit/2026-10-13-forensic-audit.md` F15 (:397) and the threat row (:985).
- `docs/audit/REMEDIATION.md`: rule 2 (closed = merged PR with an end-to-end test of a real user flow, RED before and GREEN after), rule 3 (ticked only after an independent re-audit). This document claims neither closure nor a tick.

Scope: the shared mask (`platform/p1/maskOutboundPII.ts`), a new normaliser (`platform/p1/piiText.ts`), a new residual detector (`platform/p1/residualPII.ts`), the rank >= 3 check (`platform/p1/providerPolicy.ts` `assertMinimised`), the Functions gateway and committeeBrain (`functions/src/p1/gateway.ts`, `functions/src/p1/ops.ts`), and their docs. Not touched: `platform/http/withSession.ts`, `platform/p5/session.ts`, `platform/persistence/adminFirestore.ts`, `platform/persistence/firestoreSpineRepositories.ts`, `platform/p5/committeeScope.ts`, `platform/p5/insecureDevAuth.ts` (PR #44), and `app/api/**`.

## 1. Root cause, traced from the code

`maskOutboundPII` (`platform/p1/maskOutboundPII.ts:28-36, 42-107` on main) runs eight ASCII regexes (`\d`, `[.\-\s]`, `\b`) over the raw text, then each supplied party name as a literal, case-insensitive regex (`:85-93`). Three consequences:

1. **Unicode identifiers are invisible.** `\d` matches only U+0030-0039. A full-width CNIC (`３５２０２－１２３４５６７－１`, U+FF10-FF19 and U+FF0D), an Urdu-digit mobile (`۰۳۰۰-۱۲۳۴۵۶۷`, U+06F0-06F9), an Arabic-Indic or Devanagari number, or a CNIC with zero-width spaces (U+200B) between its digits matches none of the patterns. The audit's synthetic full-width CNIC and Urdu phone produced zero redactions.
2. **Names match only as typed.** `new RegExp(escapeRegExp(name), "gi")` matches the exact code points with ASCII case folding. `TARIQ  ZARVANI` (two spaces), `Tariq Zarvani` (NBSP), `طارق زروانی` written with Arabic yeh (`ي` U+064A) instead of Urdu yeh (`ی` U+06CC), or with harakat, all survive. Names come only from `matter_parties` rows and the request (`functions/src/p1/ops.ts:210-223`); the matter's client record is not read.
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

`platform/p1/internalAICaller.ts` (the Next route, F18, to be retired by O-53) inherits the normalised mask, the client of ruling 3, and the stronger `assertMinimised` with no code change; its rank >= 3 refusal text is unchanged. It does not record residual counts: its persisted output goes through `firestoreSpineRepositories.ts`, which PR #44 holds. `platform/p1/eveTools.ts` `maskPreview` and `platform/p1/translate.ts` get the new mask unchanged.

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

- **Not anonymisation.** Names the firm never recorded in `matter_parties`, the client record or the request; semantic identifying facts; free-text addresses and relationships without a cue; identifiers written in words or with look-alike letters; multi-character separators. At ranks 0 to 2 the residual findings are counted, not masked or blocked.
- **Human review is not built.** L18 §4.6 / L17.13a/h's partner-authorised exception (with a recorded reason) and the deterministic-only path remain `TODO(firm)` (`providerPolicy.ts`). A residual finding at rank 3 or 4 is a hard block with no override; there is no high-risk review queue.
- **False positives block privileged calls.** The residual detector is tuned to a legal-prose corpus, but unusual numbering (a six-digit case number followed directly by a date) or label-like prose can block a rank 3 or 4 call `not_minimised`. That fails closed.
- **Homoglyphs.** NFKC does not fold cross-script look-alikes (Cyrillic `а` in a Latin name); such a name is not matched.
- **A dropped invisible character can remove a word boundary.** `CNIC​3520212345671` becomes `CNIC3520212345671` in the detection view, and the CNIC pattern's leading `\b` no longer holds, so the mask misses it (as main did for the ASCII form `CNIC3520212345671`). The residual detector still counts the 13-digit run, so a rank 3 or 4 call is blocked; below rank 3 it is counted, not masked.
- **Client identifiers as literals.** The client record's CNIC, mobile, email and address are not used as literal masks (ruling 4).
- **Next legacy path** records no residual counts (ruling 8).
- **Classification is still the gate.** A privileged text mislabelled `internal` is masked and counted, not blocked: the audit's mislabelling scenario is reduced (the counterexample's identifiers are now masked) but not eliminated.

## 6. Alternatives rejected

- **NER for names.** Rejected (main's header): masking every capitalised word destroys legal prose and still misses Urdu names.
- **Normalising the outbound text itself** (sending the NFKC form). Rejected: it changes text the firm wrote outside any identifier; the view-and-map approach keeps unmatched text exactly.
- **A new `BlockReason` (`residual_pii`).** Rejected: the obligation is the same L18 §4.6 minimisation; the residual counts on the output row say why.
- **Masking residual findings.** Rejected for this finding: the cues are context, not identifier formats, and masking text after `s/o` or `r/o` blindly would replace the wrong span as often as the right one. They block where the obligation applies and are counted elsewhere.
