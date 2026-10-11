#!/usr/bin/env bash
# Gate G-4 (Phase 4a) — the gated draft in Cloud Functions (P4-1..P4-15): the D4-1 draft store (versions, restore,
# lock), the D4-2 citation and temporal gate, the audited partner override bound to one version and one reviewed gate
# result, and the partner approval stand-in. `npm run gate:g4:phase4a`.
#
# 1. route coverage by domain (check_route_coverage.py): 21 /api/d1 routes, 4 /api/platform/jobs routes, 5
#    /api/platform/brain routes, 8 /api/d4/drafting routes and 4 /api/d4/intelligence routes, each exercised by a
#    viaApi test
# 2. disable-every-layer boot checks (functions/test/d1.boot.test.ts and p2.boot.test.ts; no emulator needed).
#    D4 has no layer flag in Cloud Functions (like P1, P3-60), so nothing of D4 can be switched off at boot; the D4
#    boot assertion (functions/test/d4.boot.test.ts: the twelve D4 routes, the production EMPTY_AUTHORITY_STORE and
#    the index exemptions) is a named test in step 3
# 3. the named Phase 4a tests, selected by exact full name (the gate counts them from the name arrays below), under
#    the Auth and Firestore emulators:
#    a. functions/test: d4.boot.test.ts, d4.gate.test.ts, d4.doctypes.test.ts, d4.drafts.emu.test.ts, d4.gate.emu.test.ts
#      - the pure gate (P4-6): the severity order, an out-of-domain status failing closed, the G-1 test 4 and test 5
#        cores (an overruling by a larger bench is OVERRULED; a 2015 check against a 2018 amendment is
#        TEMPORAL_MISMATCH with the text in force; no history is TEMPORAL_UNAVAILABLE, never a silent pass), the
#        jurisdiction on the section lookup (E-39(1)), the empty production authority store (P4-3) and the test
#        seam refused when NODE_ENV is production
#      - the document types (E-15, R2): only VERIFIED rows are selectable, the court rule, a NON_FORUM type allowed
#        on any matter, a family court entry
#      - the draft store (P4-4, P4-5, P4-12): create (the court check, the classification that only rises, the
#        `internal` floor, R3; a closed matter refused, R4), hostile text and the size caps (422
#        unsupported_characters, draft_too_large, title_too_long), save (a stale baseVersion is draft_changed,
#        an identical save writes nothing, two and four saves racing on one base give exactly one new version and
#        dense numbers), restore, the lock, the reads, the pagination, and every access refusal (an intern, a
#        client, accounts, a non-member, another firm's caller)
#      - the gate, override and approval (P4-6..P4-8, G-1 tests 4 and 5): version pinning (a save after a gate or an
#        override: draft_changed or not_gated; an override never clears the next version, nor a restored body),
#        the corpus-change test (a cleared UNVERIFIED that became OVERRULED blocks approval), R5 (a version with an
#        override is not re-gated: Probes A and C), R6 and R9 (an override and an approval name the gate result the
#        partner reviewed: Probe B, PROBE-1 and 1b), R10 (checks carried forward per draft, merged by key, the merged
#        caps), R11 (the jurisdiction pattern) and no two checks on one key (PROBE-2), R7 (the charset rule on a
#        usedText and a reason; CRLF is LF), R8 (the temporal-text and
#        result size caps: 400 invalid_temporal_checks, 422 gate_result_too_large, never truncated), two partners
#        overriding at once, two approvals at once, a re-gate landing during an approval, the approval's re-run
#        with the recorded checks, the lock, and the verification report
#    b. tests/: firestore.rules.d4-phase4a.test.ts (no client writes drafts, draft_versions, draft_gate_results or
#       draft_gate_overrides; the two gate collections are unreadable too; P4-11; drafts and versions are read only by
#       an author-role member cleared for the row's and the matter's current label: interns denied, PROBE-5) and
#       citationVerdict.test.ts (the pure verdict rule shared with the Next.js tree, P4-2)
# 4. functions lint at zero warnings (npx eslint --max-warnings 0 functions)
# 5. Gate G-2, cross-firm isolation over all routes (ci_gates/gate_g2.sh; starts its own emulators)
#
# Emulator ports follow gate_g2.sh: in CI the repo firebase.json and demo-sikander; a local run
# gets a temporary config with ephemeral ports and its own demo project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The names below are the full names vitest reports: the describe titles, then the test title, joined by single
# spaces (copied from `vitest list --json=<file>`; every one exists exactly once). Renaming a test fails this gate
# until the name here is changed with it.

# --- functions/test/d4.boot.test.ts (the D4 routes at boot, the production store, the index exemptions; no emulator)
D4_BOOT_TESTS=(
  'D4 boot (P4-3, P4-10) the entry point exports api, and the router built with every layer flag off serves exactly the twelve D4 routes, each kind general'
  "D4 boot (P4-3, P4-10) the production authority store is EMPTY_AUTHORITY_STORE: a fresh load of the gate's modules runs on it"
  'D4 boot (P4-3, P4-10) firestore.indexes.json exempts the stored text and findings from single-field indexing'
)

# --- functions/test/d4.gate.test.ts (the pure gate and the authority port; no emulator) --------------------
GATE_UNIT_TESTS=(
  # GATE_SEVERITY (P4-6)
  'GATE_SEVERITY (P4-6) lists the overall statuses most severe first'
  'GATE_SEVERITY (P4-6) is frozen'
  # runGate: citations
  'runGate: citations G-1 test 4 core: a division-bench judgment overruled by a larger bench is OVERRULED overall'
  'runGate: citations an overruling by a known larger bench is OVERRULED, by an equal known bench UNVERIFIED'
  'runGate: citations a followed judgment is VERIFIED and the draft is OK'
  'runGate: citations a citation the store does not know is UNVERIFIED with no judgment id'
  'runGate: citations reads citations from the title as well as the body'
  'runGate: citations an UNRECOGNISED suspect is UNVERIFIED and is never looked up'
  'runGate: citations an UNRECOGNISED suspect alone makes no store call at all'
  'runGate: citations the same citation written two ways is one finding, matched against a store that spells it a third way'
  'runGate: citations two canonical refs that resolve to one judgment (parallel citations) are one finding, the first ref shown'
  'runGate: citations two unknown refs stay two findings, in the order the extractor finds them'
  "runGate: citations asks the store for the canonical form of a ref, never the draft's own spelling"
  # runGate: severity order (P4-6)
  'runGate: severity order (P4-6) OVERRULED outranks UNVERIFIED'
  'runGate: severity order (P4-6) TEMPORAL_MISMATCH outranks UNVERIFIED'
  'runGate: severity order (P4-6) OVERRULED outranks TEMPORAL_MISMATCH'
  'runGate: severity order (P4-6) UNVERIFIED outranks TEMPORAL_UNAVAILABLE'
  'runGate: severity order (P4-6) TEMPORAL_UNAVAILABLE alone is the overall status, and is not OK'
  'runGate: severity order (P4-6) a VERIFIED citation and an OK temporal check both count as OK'
  'runGate: severity order (P4-6) one bad temporal check among good ones decides the status'
  # runGate: an out-of-domain status fails closed
  'runGate: an out-of-domain status fails closed a status outside the domain alone is UNVERIFIED overall, not OK'
  'runGate: an out-of-domain status fails closed beside a VERIFIED citation it still decides UNVERIFIED, never OK'
  'runGate: an out-of-domain status fails closed does not hide a more severe status'
  'runGate: an out-of-domain status fails closed an empty list is still OK'
  # runGate: temporal checks (P4-6, E-39)
  'runGate: temporal checks (P4-6, E-39) G-1 test 5 core: a 2015 check using the 2018 text is TEMPORAL_MISMATCH and carries the text in force'
  'runGate: temporal checks (P4-6, E-39) the same check using the 2015 text is OK'
  'runGate: temporal checks (P4-6, E-39) a date inside the later version selects the later text'
  'runGate: temporal checks (P4-6, E-39) effectiveFrom is inclusive and effectiveTo is exclusive'
  'runGate: temporal checks (P4-6, E-39) a date before the first version is TEMPORAL_UNAVAILABLE: nothing was in force'
  'runGate: temporal checks (P4-6, E-39) a date after a closed final version is TEMPORAL_UNAVAILABLE'
  'runGate: temporal checks (P4-6, E-39) a section with no history is TEMPORAL_UNAVAILABLE, never a silent pass'
  "runGate: temporal checks (P4-6, E-39) a wrong jurisdiction is TEMPORAL_UNAVAILABLE, not a match on another jurisdiction's text (E-39(1))"
  'runGate: temporal checks (P4-6, E-39) the same section keeps its versions apart per jurisdiction'
  'runGate: temporal checks (P4-6, E-39) compares after NFC on both sides: a decomposed usedText equals a precomposed in-force text, and the reverse'
  'runGate: temporal checks (P4-6, E-39) is otherwise exact: a changed word, case or space is a mismatch'
  'runGate: temporal checks (P4-6, E-39) returns one finding per check, in order, even when two checks are identical'
  'runGate: temporal checks (P4-6, E-39) builds each finding from the four check fields only: an extra property on the input does not reach the result'
  'runGate: temporal checks (P4-6, E-39) sends the store only the section key, the date and the jurisdiction'
  'runGate: temporal checks (P4-6, E-39) does not change the checks it is given'
  # runGate: nothing to gate
  'runGate: nothing to gate an empty body and no checks give OK with empty lists'
  'runGate: nothing to gate prose without a citation and no checks give OK'
  # EMPTY_AUTHORITY_STORE (P4-3: the production adapter until O-59)
  'EMPTY_AUTHORITY_STORE (P4-3: the production adapter until O-59) has no judgment, no treatment and no history'
  'EMPTY_AUTHORITY_STORE (P4-3: the production adapter until O-59) turns every citation UNVERIFIED and every check TEMPORAL_UNAVAILABLE'
  'EMPTY_AUTHORITY_STORE (P4-3: the production adapter until O-59) is frozen'
  # InMemoryAuthorityStore
  'InMemoryAuthorityStore findJudgment matches on the normalised stored citation'
  'InMemoryAuthorityStore a stored citation the extractor cannot read never matches anything'
  "InMemoryAuthorityStore listTreatments gives the treating judgment's bench when it is stored, else null, plus the recorded bench"
  'InMemoryAuthorityStore getSectionAsAt returns the text in force or no_history'
  # the test seam (P4-3)
  'the test seam (P4-3) activeAuthorityStore is the empty store until a test sets one'
  'the test seam (P4-3) returns the store a test set, and the empty store again after null'
  'the test seam (P4-3) throws when NODE_ENV is production, and leaves the active store alone'
)

# --- functions/test/d4.doctypes.test.ts (the verified document-type catalogue and the court rule; no emulator) ---
DOCTYPE_TESTS=(
  # getDocumentType (P4-5: only VERIFIED types are selectable, E-15)
  'getDocumentType (P4-5: only VERIFIED types are selectable, E-15) returns the seed row for a known id'
  'getDocumentType (P4-5: only VERIFIED types are selectable, E-15) returns null for an unknown id'
  'getDocumentType (P4-5: only VERIFIED types are selectable, E-15) an object-prototype name is not a type'
  'getDocumentType (P4-5: only VERIFIED types are selectable, E-15) every seed row is reachable by its id'
  'getDocumentType (P4-5: only VERIFIED types are selectable, E-15) a row is frozen, so a caller cannot change the seed it reads'
  'getDocumentType (P4-5: only VERIFIED types are selectable, E-15) does not return, or list, a row whose status is not VERIFIED'
  # courtAllowed (P4-5)
  'courtAllowed (P4-5) is true for a court the type lists'
  'courtAllowed (P4-5) is false for a court the type does not list'
  'courtAllowed (P4-5) is true when there is no court (the matter has none)'
  'courtAllowed (P4-5) reads a trailing * in the seed as a family of courts, and no other pattern'
  'courtAllowed (P4-5) a * that is not the last character is literal'
  'courtAllowed (P4-5) a _* entry with an empty family admits nothing'
  "courtAllowed (P4-5) a NON_FORUM type (notice, contract, affidavit) is allowed whatever the matter's court (R2)"
  'courtAllowed (P4-5) a mixed type that lists NON_FORUM beside a court family is allowed for any court'
  'courtAllowed (P4-5) NON_FORUM is an entry, not a court: a type without it stays restricted'
  'courtAllowed (P4-5) a type that lists no court allows none, but still allows a matter with no court'
  # listDocumentTypes (P4-5)
  'listDocumentTypes (P4-5) with no filter lists every verified type, sorted by id'
  'listDocumentTypes (P4-5) filters by category'
  'listDocumentTypes (P4-5) filters by courtId with the same rule as courtAllowed (the court listed, or NON_FORUM), sorted'
  "listDocumentTypes (P4-5) a courtId of a family court matches the family's * entries"
  'listDocumentTypes (P4-5) filters by q on the name, case-insensitively, sorted'
  'listDocumentTypes (P4-5) q matches the name only, not the id'
  'listDocumentTypes (P4-5) a blank q is no filter'
  'listDocumentTypes (P4-5) combines courtId and q'
  'listDocumentTypes (P4-5) combines category with the other filters'
  'listDocumentTypes (P4-5) matches nothing for a query no name contains'
  "listDocumentTypes (P4-5) returns a new array each time, so a caller cannot reorder the module's own list"
  'listDocumentTypes (P4-5) an unsorted seed order is not the output order'
)

# --- functions/test/d4.drafts.emu.test.ts (the draft store routes) --------------------------------------------
DRAFT_TESTS=(
  # createDraft (P4-4, P4-5, P4-12)
  'createDraft (P4-4, P4-5, P4-12) creates the draft, version 1 (kind create), the draft.autosaved event and the audit row in one go'
  'createDraft (P4-4, P4-5, P4-12) partner, associate and clerk members can create; the creator is the authenticated caller'
  'createDraft (P4-4, P4-5, P4-12) stores the NFC-normalised text and hashes that stored text; the title is trimmed'
  'createDraft (P4-4, P4-5, P4-12) an empty body is a draft (the editor starts blank)'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission matterId missing → 400 matter_required, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission matterId empty → 400 matter_required, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission matterId not a string → 400 matter_required, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission documentTypeId missing → 400 invalid_document_type, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission documentTypeId empty → 400 invalid_document_type, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission documentTypeId not a string → 400 invalid_document_type, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission documentTypeId unknown → 404 document_type_not_found, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission documentTypeId an Object.prototype key → 404 document_type_not_found, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission title missing → 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission title blank → 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission title not a string → 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission body missing → 400 invalid_body, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission body null → 400 invalid_body, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission body not a string → 400 invalid_body, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission classification not a label → 400 invalid_classification, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission classification not a string → 400 invalid_classification, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission classification an Object.prototype key → 400 invalid_classification, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission classification null → 400 invalid_classification, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission the checks run in the stated order: matter, type, title, body, classification'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with LF inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with CR inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with TAB inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with NUL inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with BEL inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with VT inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with FF inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with ESC inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with US inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with DEL inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with PAD (C1) inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with NEL (C1) inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with APC (C1) inside is 400 invalid_title, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a title with a control at either end is refused too (it is judged before the trim)'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission a control in the title is invalid_title, not unsupported_characters, when the title also has a hostile character'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission ordinary spaces are fine, trimmed at the ends; a control in the body is not a title problem'
  'createDraft (P4-4, P4-5, P4-12) input checks, in order, before the permission the checks come before the permission: an intern with a bad title gets 400, not 403'
  'createDraft (P4-4, P4-5, P4-12) access (P4-10) an intern, a client and accounts are refused 403, and a partner who is not a member of the matter too; nothing is stored'
  "createDraft (P4-4, P4-5, P4-12) access (P4-10) a missing matter and another firm's matter are both 404 not_found (existence never leaks)"
  'createDraft (P4-4, P4-5, P4-12) access (P4-10) a malformed matter id is refused, not queried'
  "createDraft (P4-4, P4-5, P4-12) access (P4-10) clearance below the matter's label is 403 clearance; a matter with an unreadable label fails closed the same way"
  'createDraft (P4-4, P4-5, P4-12) access (P4-10) a refusal is audited as a deny under draft.create'
  "createDraft (P4-4, P4-5, P4-12) the court check (P4-5, E-15) a type that does not list the matter's court is 422 court_mismatch, nothing stored"
  'createDraft (P4-4, P4-5, P4-12) the court check (P4-5, E-15) a type that lists the court, a family that admits it, a NON_FORUM type and a matter with no court are accepted'
  "createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) with no label the draft takes the matter's"
  "createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) a caller label at or above the matter's is the draft's (the stricter)"
  "createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) a caller label below the matter's is 422 classification_below_matter, nothing stored"
  "createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) a label above the caller's clearance is 403 clearance"
  'createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) the internal floor (R3: caller-authored text is never rank 0, as committeeBrain) a public matter gives an internal draft: the draft, version 1 and the event are labelled internal'
  'createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) the internal floor (R3: caller-authored text is never rank 0, as committeeBrain) a public request on a public matter is floored to internal, not refused'
  'createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) the internal floor (R3: caller-authored text is never rank 0, as committeeBrain) a higher request on a public matter is the stricter, as before'
  "createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) the internal floor (R3: caller-authored text is never rank 0, as committeeBrain) classification_below_matter stays relative to the matter's own label: an internal matter refuses public"
  'createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) the internal floor (R3: caller-authored text is never rank 0, as committeeBrain) a caller cleared only to public gets 403 clearance on a public matter (the floor is the result the clearance must reach)'
  'createDraft (P4-4, P4-5, P4-12) classification (P4-5, L17.3 #20: monotonic) the internal floor (R3: caller-authored text is never rank 0, as committeeBrain) saves and restores on a floored draft carry its internal label on the versions and the events'
  'createDraft (P4-4, P4-5, P4-12) a closed matter (R4) createDraft on a closed matter is 409 matter_closed, nothing stored'
  'createDraft (P4-4, P4-5, P4-12) a closed matter (R4) the permission still comes first: an intern or a non-member on a closed matter is refused 403, not told it is closed'
  'createDraft (P4-4, P4-5, P4-12) a closed matter (R4) a matter that is open (or has no status) still takes new drafts'
  'createDraft (P4-4, P4-5, P4-12) a closed matter (R4) saves and restores on an existing draft of a closed matter stay allowed (recorded for later)'
  'createDraft (P4-4, P4-5, P4-12) text checks (SEC-1, R3): refused, never stored a body with a bidirectional control is 422 unsupported_characters'
  'createDraft (P4-4, P4-5, P4-12) text checks (SEC-1, R3): refused, never stored a title with an invisible character, or a body with a confusable Cyrillic letter in a Latin word, is 422 unsupported_characters'
  'createDraft (P4-4, P4-5, P4-12) text checks (SEC-1, R3): refused, never stored a title over 500 characters is 422 title_too_long; 500 is accepted'
  'createDraft (P4-4, P4-5, P4-12) text checks (SEC-1, R3): refused, never stored a body over 500,000 characters is 422 draft_too_large'
  'createDraft (P4-4, P4-5, P4-12) text checks (SEC-1, R3): refused, never stored an Urdu body over 900,000 UTF-8 bytes but under 500,000 characters is 422 draft_too_large, not truncated; 900,000 bytes is accepted'
  'createDraft (P4-4, P4-5, P4-12) text checks (SEC-1, R3): refused, never stored a hostile body from a caller who is not allowed is refused for the permission first (no oracle)'
  'createDraft (P4-4, P4-5, P4-12) a retry with the same Idempotency-Key replays the first answer and stores one draft'
  # saveDraftVersion (P4-4, P4-12)
  'saveDraftVersion (P4-4, P4-12) writes version 2 (kind save), updates the draft, writes the event and the audit row, and answers saved: true'
  'saveDraftVersion (P4-4, P4-12) a changed title alone, or a changed body alone, is a new version'
  'saveDraftVersion (P4-4, P4-12) an identical save (same title and body as the current version) writes nothing: saved false, the draft unchanged, one allow row, no event'
  'saveDraftVersion (P4-4, P4-12) an identical save is judged on the stored (normalised) text: the same text with CRLF and untrimmed padding is identical'
  'saveDraftVersion (P4-4, P4-12) an identical save still needs the right baseVersion (a stale one is draft_changed, not a quiet no-op)'
  'saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction a stale or a future baseVersion is 409 draft_changed and writes nothing'
  "saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction a refused stale save writes a deny row on the route's audit (draft.edit, drafts/<id>, reason draft_changed), and no event or version"
  'saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction a refused save on a locked draft writes a deny row with reason draft_locked'
  'saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction a baseVersion that is not a positive integer is 400 invalid_version'
  'saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction a locked draft is 409 draft_locked, and the lock is checked before the baseVersion'
  'saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction a locked draft refuses even an identical save (the lock is not a quiet success)'
  'saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction two saves on the same base: exactly one succeeds, the other is draft_changed, and the versions are dense'
  'saveDraftVersion (P4-4, P4-12) baseVersion and the lock, checked inside the transaction four saves racing on one base: exactly one wins, the rest are draft_changed, nothing is skipped'
  'saveDraftVersion (P4-4, P4-12) sequential saves give dense versions 1..5, each with its own hash, and every version stays readable'
  "saveDraftVersion (P4-4, P4-12) a new version is not gated: the draft's gate summary is reset (the old result stays in draft_gate_results)"
  "saveDraftVersion (P4-4, P4-12) the version carries the draft's classification, not a fresh one"
  "saveDraftVersion (P4-4, P4-12) a version saved after the matter's label is raised carries the raised label"
  'saveDraftVersion (P4-4, P4-12) input and text checks draftId, title and body must be well formed (400), and nothing is stored'
  'saveDraftVersion (P4-4, P4-12) input and text checks a title with a control character (LF, CR, TAB, any C0 or C1, DEL) is 400 invalid_title and stores nothing'
  'saveDraftVersion (P4-4, P4-12) input and text checks a hostile body or title is 422 unsupported_characters and stores nothing; an oversize title or body is 422 too'
  'saveDraftVersion (P4-4, P4-12) access (P4-10) an intern, a client, accounts and a non-member partner are refused 403; nothing is stored'
  "saveDraftVersion (P4-4, P4-12) access (P4-10) a missing draft, a malformed id and another firm's draft are all 404 not_found"
  "saveDraftVersion (P4-4, P4-12) access (P4-10) a draft above the caller's clearance is 404, and a caller whose clearance reaches it can edit"
  "saveDraftVersion (P4-4, P4-12) access (P4-10) the permission is decided on the draft's own matter: a member of another matter of the firm is refused"
  # restoreDraftVersion (P4-4)
  'restoreDraftVersion (P4-4) restores an earlier version as a new one: kind restore, restoredFrom, the draft takes that title and body'
  'restoreDraftVersion (P4-4) restoring a version whose title and body equal the current one writes nothing (saved false)'
  'restoreDraftVersion (P4-4) a fromVersion that does not exist is 404 version_not_found; a malformed one is 400 invalid_version'
  'restoreDraftVersion (P4-4) a stale baseVersion is 409 draft_changed; a locked draft is 409 draft_locked first'
  'restoreDraftVersion (P4-4) a stale baseVersion is checked before the fromVersion exists check'
  'restoreDraftVersion (P4-4) two restores on the same base: exactly one succeeds'
  "restoreDraftVersion (P4-4) only the draft's own versions can be restored (the id is built from the named draft)"
  "restoreDraftVersion (P4-4) access: an intern, a client, accounts and a non-member are refused; another firm's draft is 404"
  # getDraft (P4-4, P4-10)
  "getDraft (P4-4, P4-10) returns the draft view with the current version's title and body"
  "getDraft (P4-4, P4-10) returns a requested version's title and body while the view stays the draft's current state"
  'getDraft (P4-4, P4-10) an unknown version is 404 version_not_found; a malformed one is 400 invalid_version'
  'getDraft (P4-4, P4-10) returns the stored text exactly, including a body at the byte cap'
  'getDraft (P4-4, P4-10) shows the lock, the approval fields and the gate summary the server holds'
  'getDraft (P4-4, P4-10) access: partner, associate and clerk members read; an intern, a client, accounts and a non-member are refused'
  "getDraft (P4-4, P4-10) a missing draft, a malformed id and another firm's draft are 404 not_found; no draftId is 400; a draft above the clearance is 404"
  "getDraft (P4-4, P4-10) the body of another firm's draft never reaches the answer"
  # listDrafts (P4-4, P4-10)
  'listDrafts (P4-4, P4-10) requires a matterId: missing, empty and not-a-string are 400 matter_required'
  "listDrafts (P4-4, P4-10) lists the matter's drafts newest first by updatedAt then id, metadata only (no body)"
  'listDrafts (P4-4, P4-10) is audited as an allow under draft.read on the matter'
  'listDrafts (P4-4, P4-10) a save moves the draft to the top; ties on updatedAt break by id descending'
  'listDrafts (P4-4, P4-10) pages through drafts that share one updatedAt without a gap or a repeat (the id breaks the tie)'
  'listDrafts (P4-4, P4-10) paginates with limit and cursor without gaps or repeats'
  'listDrafts (P4-4, P4-10) a bad limit or cursor is 400'
  "listDrafts (P4-4, P4-10) lists only the named matter's drafts of the caller's firm, and hides drafts above the caller's clearance"
  "listDrafts (P4-4, P4-10) access: an intern, a client, accounts and a non-member are refused; another firm's matter and a missing one are 404"
  'listDrafts (P4-4, P4-10) a partner who is not a member of the matter sees nothing (R-2: no role is exempt)'
  # listDraftVersions (P4-4, P4-10)
  'listDraftVersions (P4-4, P4-10) lists the versions newest first with metadata only'
  'listDraftVersions (P4-4, P4-10) paginates with limit and cursor'
  "listDraftVersions (P4-4, P4-10) lists only the named draft's versions"
  "listDraftVersions (P4-4, P4-10) access: refused for an intern, a client, accounts and a non-member; 404 for another firm's, a missing and an above-clearance draft; 400 with no draftId"
  # listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15)
  'listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) lists the verified types sorted by id, 20 to a page by default, summary rows only'
  'listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) pages through every verified type exactly once'
  'listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) filters by category, court (NON_FORUM and families included) and a part of the name, alone and together'
  'listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) a bad limit or cursor is 400; an over-long filter is 400 invalid_query'
  'listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) getTypeProfile returns the whole seed row'
  'listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) getTypeProfile: an unknown type is 404 document_type_not_found, a missing or non-string typeId is 400 invalid_document_type'
  'listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) doctype.read is firm-level: partner, associate and clerk read; an intern, a client and accounts are refused (a non-member partner is fine)'
  "listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15) another firm's header is refused before any data (the firm comes from the header, never the body)"
)

# --- functions/test/d4.gate.emu.test.ts (the gate, override and approval routes; the G-1 test 4 and 5 equivalents) -
GATEOPS_TESTS=(
  # normaliseEvaluation: the status domain before anything is stored or compared
  'normaliseEvaluation: the status domain before anything is stored or compared a citation status outside VERIFIED / UNVERIFIED / OVERRULED becomes UNVERIFIED, and the overall status is recomputed from the findings'
  'normaliseEvaluation: the status domain before anything is stored or compared a temporal status outside the temporal domain becomes TEMPORAL_UNAVAILABLE (verify manually), never OK'
  'normaliseEvaluation: the status domain before anything is stored or compared an overall status outside the domain is UNVERIFIED, and a more severe finding still wins'
  "normaliseEvaluation: the status domain before anything is stored or compared never lowers the runner's overall status: a stated OVERRULED stays OVERRULED"
  'normaliseEvaluation: the status domain before anything is stored or compared keeps only the named fields of each finding'
  # approvalPasses and clearedItemsOf (P4-7, P4-8)
  'approvalPasses and clearedItemsOf (P4-7, P4-8) clearedItemsOf lists every non-OK citation and temporal entry with its status, and nothing that passed'
  'approvalPasses and clearedItemsOf (P4-7, P4-8) an OK evaluation passes with or without an override'
  'approvalPasses and clearedItemsOf (P4-7, P4-8) a non-OK evaluation passes only when an override with the same hash clears every non-OK item with the same status'
  'approvalPasses and clearedItemsOf (P4-7, P4-8) a cleared UNVERIFIED that is now OVERRULED is not cleared; a cleared TEMPORAL_UNAVAILABLE that is now a mismatch is not cleared'
  'approvalPasses and clearedItemsOf (P4-7, P4-8) a non-OK status with no non-OK item to name cannot be cleared, even by an override with an empty list'
  'approvalPasses and clearedItemsOf (P4-7, P4-8) a cleared item whose kind or status is outside the domain clears nothing (fails closed)'
  # parseTemporalChecks (P4-6): 400 invalid_temporal_checks
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks absent is no checks; anything but an array is refused'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks at most 20 entries; each entry an object with the four fields'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks sectionId matches /^[A-Za-z0-9_.:-]{1,200}$/'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks asAtDate is a real YYYY-MM-DD calendar date'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks jurisdiction is 1 to 50 characters; usedText is 1 to 10,000 characters'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks the usedText of all entries together is at most 200,000 UTF-8 bytes (R8)'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks returns only the four fields of each entry (anything else the caller sent is dropped)'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks two checks sharing a key are refused 400 invalid_temporal_checks'
  'parseTemporalChecks (P4-6): 400 invalid_temporal_checks jurisdiction matches /^[A-Z0-9_.:-]{1,50}$/: a trailing space, a no-break space, lowercase and a decomposed accent are refused (R11)'
  # G-1 equivalents (P4-14)
  "G-1 equivalents (P4-14) G-1 test 4: an authority overruled by a larger bench blocks approval until the matter's partner overrides with a reason"
  'G-1 equivalents (P4-14) G-1 test 5: a 2015-dated check against a section amended in 2018 is TEMPORAL_MISMATCH with both texts; no history is TEMPORAL_UNAVAILABLE'
  # gateDraft (P4-6, P4-12)
  "gateDraft (P4-6, P4-12) gates the current version: the result, the draft's summary, the draft.gated event and the audit row in one go"
  "gateDraft (P4-6, P4-12) reports and never rewrites: the version's title and body are unchanged and no version is added"
  'gateDraft (P4-6, P4-12) reads citations from the title as well as the body'
  'gateDraft (P4-6, P4-12) re-gating the same version replaces the result and writes a distinct draft.gated event per run'
  'gateDraft (P4-6, P4-12) the run count is per version: the first gate of version 2 is <draftId>_2_gated_1'
  'gateDraft (P4-6, P4-12) a version that is not the current one is 409 draft_changed, and nothing is written'
  'gateDraft (P4-6, P4-12) the input checks come first: a malformed version is 400 invalid_version, no draftId is 400 invalid_query'
  'gateDraft (P4-6, P4-12) bad temporal checks are 400 invalid_temporal_checks through the route; 20 good ones are accepted'
  "gateDraft (P4-6, P4-12) access: partner, associate and clerk members gate; an intern, a client, accounts and a non-member are refused; another firm's draft is 404"
  'gateDraft (P4-6, P4-12) R5: once a version is overridden it is not re-gated (409 already_overridden): the cleared check set is frozen, nothing is written'
  'gateDraft (P4-6, P4-12) R5 Probe A: after the override the store gains a differing history for the cleared section; a re-gate with no checks is refused, and approval is blocked'
  'gateDraft (P4-6, P4-12) R5 Probe C: after the override a re-gate with another usedText under the same key is refused (409 already_overridden)'
  'gateDraft (P4-6, P4-12) R7: a usedText with a bidi control or a zero-width space is 422 unsupported_characters (a jurisdiction with one is 400 under R11); nothing is stored'
  'gateDraft (P4-6, P4-12) R7: the stored usedText and jurisdiction are the NFC-normalised text, without dash or digit folding (statute text keeps its em dash)'
  'gateDraft (P4-6, P4-12) a check recorded on v1 is carried to v2 when v2 is gated without it'
  "gateDraft (P4-6, P4-12) the caller's usedText replaces a carried check's usedText on the same key"
  'gateDraft (P4-6, P4-12) a merged set over 20 checks is 400 invalid_temporal_checks'
  'gateDraft (P4-6, P4-12) a merged set over 200,000 UTF-8 bytes of usedText is 400 invalid_temporal_checks'
  'gateDraft (P4-6, P4-12) a CRLF usedText equal to an LF in-force text is OK, not MISMATCH'
  'gateDraft (P4-6, P4-12) R8: temporal checks over 200,000 UTF-8 bytes in all are 400 invalid_temporal_checks, before the permission'
  'gateDraft (P4-6, P4-12) R8: a result over 900,000 bytes is 422 gate_result_too_large; nothing is stored, the in-force text is never truncated'
  # overrideGate (P4-7)
  'overrideGate (P4-7) records every non-OK citation and temporal entry with its status, and nothing that passed'
  'overrideGate (P4-7) the author-partner may override their own draft; the audit row names them'
  'overrideGate (P4-7) refusals: draft_changed, not_gated, nothing_to_override, already_overridden; nothing is written'
  'overrideGate (P4-7) a reason must be 20 to 2,000 characters after trimming (400 invalid_reason); the bounds are accepted'
  'overrideGate (P4-7) a malformed version is 400 invalid_version'
  'overrideGate (P4-7) R6: a missing or non-string resultId is 400 invalid_result_id, before the permission'
  'overrideGate (P4-7) R6 Probe B: an override of a result the partner did not review is 409 gate_result_changed; on the reviewed one it clears what was shown'
  'overrideGate (P4-7) R6 Probe B, re-gate variant: a re-gate before the override changes the result id too'
  'overrideGate (P4-7) R7: a reason with a bidi control or a zero-width space is 422 unsupported_characters; the stored reason is NFC-normalised'
  'overrideGate (P4-7) access: a clerk, a client, accounts and an associate are refused; refusals are audited as denies on the override doc'
  'overrideGate (P4-7) two partners overriding at once: exactly one override is written, the other is already_overridden'
  # approveDraft (P4-8)
  'approveDraft (P4-8) an OK draft is approved without an override: status, lock, approver, version, the event and the audit row'
  'approveDraft (P4-8) a blocked approval stores the fresh result and the summary before answering 409 gate_blocked; one deny row, nothing approved'
  'approveDraft (P4-8) refusals in order: a locked draft is draft_locked, a version that is not current draft_changed, an ungated version not_gated'
  'approveDraft (P4-8) a summary for another version, or no summary, is not_gated even when a result document exists for the version'
  "approveDraft (P4-8) access: an associate, a clerk, an intern, a client, accounts and a non-member partner cannot approve; another firm's partner gets 404"
  "approveDraft (P4-8) re-runs with the temporal checks recorded in the version's result, against the store as it is now"
  'approveDraft (P4-8) R8: an approval run whose result would exceed 900,000 bytes is 422 gate_result_too_large; nothing stored, nothing approved'
  'approveDraft (P4-8) an override bound to another body hash clears nothing'
  'approveDraft (P4-8) an override that is no longer needed is not used: the corpus now verifies the authority, the summary says overridden false'
  'approveDraft (P4-8) a re-gate that lands while the approval re-runs the gate is draft_changed: never an approval on the checks it replaced'
  'approveDraft (P4-8) R9: a missing or non-string resultId is 400 invalid_result_id, before the permission'
  'approveDraft (P4-8) approval is bound to the reviewed result: a re-gate without the check after the partner reviewed a TEMPORAL_MISMATCH makes approval with the old resultId 409 gate_result_changed'
  'approveDraft (P4-8) approval is bound to the reviewed result on the production store: a re-gate without the check after the partner reviewed a TEMPORAL_UNAVAILABLE makes approval with the old resultId 409 gate_result_changed'
  'approveDraft (P4-8) two approvals at once: exactly one approves, the other is draft_locked, and draft.approved is written once'
  # pinning: a body change after a gate or an override (P4-7, P4-8)
  'pinning: a body change after a gate or an override (P4-7, P4-8) gate version 1, save version 2, approve version 1: draft_changed; approve version 2: not_gated'
  'pinning: a body change after a gate or an override (P4-7, P4-8) an override of version 1 does not clear version 2: approving version 2 after gating it is gate_blocked'
  "pinning: a body change after a gate or an override (P4-7, P4-8) restoring version 1's text as version 3 (the same body hash) still needs its own override"
  'pinning: a body change after a gate or an override (P4-7, P4-8) corpus change: an UNVERIFIED citation overridden, then overruled by a larger bench in the store, blocks approval'
  # the lock (P4-8)
  'the lock (P4-8) an approved draft refuses save, restore, gate, override and approval with 409 draft_locked; nothing is written'
  # getVerificationReport (P4-6, P4-7)
  'getVerificationReport (P4-6, P4-7) before any gate: no result, no override, not current'
  'getVerificationReport (P4-6, P4-7) after a gate and an override: the stored result, the override and current: true'
  'getVerificationReport (P4-6, P4-7) after a save the last result is shown with current: false; gating the new version shows its result and no override'
  "getVerificationReport (P4-6, P4-7) is audited as an allow under draft.read; access: an intern, a client, accounts and a non-member are refused, another firm's is 404, no draftId 400"
  # the production store (P4-3: EMPTY_AUTHORITY_STORE until O-59)
  'the production store (P4-3: EMPTY_AUTHORITY_STORE until O-59) every draft that cites an authority needs an override to approve; a draft that cites nothing and checks nothing approves'
)

# --- tests/firestore.rules.d4-phase4a.test.ts (P4-11: the draft store is written by Cloud Functions only) -------
RULES_TESTS=(
  # firestore.rules names the D4 draft collections explicitly (P4-11)
  'firestore.rules names the D4 draft collections explicitly (P4-11) draft_gate_results has its own match block, read and write false'
  'firestore.rules names the D4 draft collections explicitly (P4-11) draft_gate_overrides has its own match block, read and write false'
  "firestore.rules names the D4 draft collections explicitly (P4-11) drafts: reads need an author role, membership and clearance on the row's and the matter's labels; create, update and delete are false"
  "firestore.rules names the D4 draft collections explicitly (P4-11) draft_versions: reads need an author role, membership and clearance on the row's and the matter's labels; create, update and delete are false"
  # drafts and draft_versions: readable by a cleared member, writable by no client (P4-11)
  'drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) control: a partner, associate and clerk member read a draft and its versions'
  'drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) an intern member is denied a draft and its versions (P4-10: interns stay denied; O-68 closed)'
  'drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) PROBE-5: an internal-cleared member cannot read a draft or a version of a matter whose label was raised to privileged, even when the stored labels are internal'
  "drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) reads: a client, accounts, a non-member and another firm's partner are denied, and a clearance below the draft's"
  "drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) no client of any role creates a draft or a version (even a cleared member author at the matter's own label)"
  'drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) no client updates a draft: not its body fields, not the gate summary, status, lock or approval, not by batch'
  'drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) no client overwrites or deletes a draft or a version'
  'drafts and draft_versions: readable by a cleared member, writable by no client (P4-11) an unauthenticated client can neither read nor write them'
  # draft_gate_results is server-only (P4-11)
  'draft_gate_results is server-only (P4-11) no role of either firm reads, lists, creates, updates or deletes it'
  'draft_gate_results is server-only (P4-11) an unauthenticated client is denied too'
  # draft_gate_overrides is server-only (P4-11)
  'draft_gate_overrides is server-only (P4-11) no role of either firm reads, lists, creates, updates or deletes it'
  'draft_gate_overrides is server-only (P4-11) an unauthenticated client is denied too'
)

# --- tests/citationVerdict.test.ts (the pure verdict rule, P4-2) --------------------------------------------------
VERDICT_TESTS=(
  # benchRank
  'benchRank orders single < division < full < larger as 1 to 4'
  # verdictFromTreatments (P4-2: one rule in one place)
  'verdictFromTreatments (P4-2: one rule in one place) no treatments gives VERIFIED'
  'verdictFromTreatments (P4-2: one rule in one place) a followed treatment gives VERIFIED'
  'verdictFromTreatments (P4-2: one rule in one place) only an overruled kind counts: applied and followed beside each other stay VERIFIED'
  'verdictFromTreatments (P4-2: one rule in one place) overruled by a bench that outranks the treated one gives OVERRULED'
  'verdictFromTreatments (P4-2: one rule in one place) overruled with a recorded larger bench gives OVERRULED, whatever the treating judgment is'
  'verdictFromTreatments (P4-2: one rule in one place) overruled by an equal bench with no larger record gives UNVERIFIED'
  'verdictFromTreatments (P4-2: one rule in one place) overruled by a lower bench gives UNVERIFIED'
  'verdictFromTreatments (P4-2: one rule in one place) an unknown treating judgment recorded as division against a full bench gives UNVERIFIED'
  "verdictFromTreatments (P4-2: one rule in one place) the judgment's own bench wins over a lower recorded bench"
  'verdictFromTreatments (P4-2: one rule in one place) one qualifying overruling among several that do not qualify gives OVERRULED'
  # draftingIntelligence delegates to the same rule
  'draftingIntelligence delegates to the same rule verifyCitations returns what verdictFromTreatments returns for the same facts (2099 fixtures)'
)

if [ "${1:-}" = "--inner" ]; then
  # vitest exits 0 when -t matches nothing (a renamed test) or the emulator suites are skipped, so the JSON result
  # must show exactly the named tests passed (as many as the arrays above hold, so no literal count can drift) and
  # nothing failed. The tests are selected by their exact full names (anchored, escaped), and the JSON check repeats
  # the names, so a renamed or swapped test fails the gate. G4A_FILTER exists only to prove this can fail.
  esc() { printf '%s' "$1" | sed 's/[][\\.*^$()+?{}|]/\\&/g'; }
  filter_of() {
    local f="" n
    for n in "$@"; do f="${f:+$f|}^$(esc "$n")\$"; done
    printf '%s' "$f"
  }
  verify() { # <json> <label> <name>...
    local json="$1" label="$2"
    shift 2
    EXPECTED="$(printf '%s\n' "$@")" EXPECTED_COUNT="$#" LABEL="$label" node -e '
      const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
      console.log(`${process.env.LABEL}: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped`)
      const passed = r.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === "passed").map((a) => a.fullName).sort()
      const want = process.env.EXPECTED.split("\n").sort()
      const count = Number(process.env.EXPECTED_COUNT)
      const exact = want.length === count && passed.length === count && passed.every((n, i) => n === want[i])
      if (!exact) console.log(`passed tests are not exactly the ${count} named tests:`, JSON.stringify(passed))
      process.exit(r.numPassedTests === count && r.numFailedTests === 0 && exact ? 0 : 1)' "$json"
  }
  out="$2"
  rc=0

  fn_names=("${D4_BOOT_TESTS[@]}" "${GATE_UNIT_TESTS[@]}" "${DOCTYPE_TESTS[@]}" "${DRAFT_TESTS[@]}" "${GATEOPS_TESTS[@]}")
  fn_filter="$(filter_of "${fn_names[@]}")"
  (cd "$ROOT/functions" && npx vitest run test/d4.boot.test.ts test/d4.gate.test.ts test/d4.doctypes.test.ts test/d4.drafts.emu.test.ts test/d4.gate.emu.test.ts -t "${G4A_FILTER:-$fn_filter}" --reporter=json --outputFile="$out/d4.fn.json") || true
  verify "$out/d4.fn.json" "D4 gate, store and routes (functions)" "${fn_names[@]}" || rc=1

  root_names=("${RULES_TESTS[@]}" "${VERDICT_TESTS[@]}")
  root_filter="$(filter_of "${root_names[@]}")"
  # The rules suite reads firestore.rules from the working directory and is excluded by vitest.config.ts unless
  # FIRESTORE_EMULATOR_HOST is set (emulators:exec sets it).
  (cd "$ROOT" && npx vitest run --no-file-parallelism tests/firestore.rules.d4-phase4a.test.ts tests/citationVerdict.test.ts -t "${G4A_FILTER:-$root_filter}" --reporter=json --outputFile="$out/d4.root.json") || true
  verify "$out/d4.root.json" "D4 rules and verdict rule (root)" "${root_names[@]}" || rc=1
  exit "$rc"
fi

echo "=== Gate G-4 (Phase 4a): the gated draft ==="

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
routes_out="$out/routes.txt"
echo "--- [1] every D1, platform/jobs, platform/brain and D4 route is exercised by a test"
python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "d1 routes found: 21; d1 entries in the route table: 21" "$routes_out" || { echo "expected 21 d1 routes (20 + unmergeEntity from 3b)"; exit 1; }
python3 ci_gates/check_route_coverage.py --domain platform/jobs functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "platform/jobs routes found: 4; platform/jobs entries in the route table: 4" "$routes_out" || { echo "expected 4 platform/jobs routes"; exit 1; }
python3 ci_gates/check_route_coverage.py --domain platform/brain functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "platform/brain routes found: 5; platform/brain entries in the route table: 5" "$routes_out" || { echo "expected 5 platform/brain routes (committeeBrain, getAiUsage, setBudgetAlerts, setAiKillSwitch, setPlatformAiKillSwitch)"; exit 1; }
python3 ci_gates/check_route_coverage.py --domain d4/drafting functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "d4/drafting routes found: 8; d4/drafting entries in the route table: 8" "$routes_out" || { echo "expected 8 d4/drafting routes (createDraft, saveDraftVersion, restoreDraftVersion, getDraft, listDrafts, listDraftVersions, overrideGate, approveDraft)"; exit 1; }
python3 ci_gates/check_route_coverage.py --domain d4/intelligence functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "d4/intelligence routes found: 4; d4/intelligence entries in the route table: 4" "$routes_out" || { echo "expected 4 d4/intelligence routes (listDocumentTypes, getTypeProfile, gateDraft, getVerificationReport)"; exit 1; }

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export NODE_OPTIONS="--disable-warning=DEP0040${NODE_OPTIONS:+ $NODE_OPTIONS}"

echo "--- [2] boot with every layer flag off"
(cd "$ROOT/functions" && npx vitest run test/d1.boot.test.ts test/p2.boot.test.ts)

config="$ROOT/firebase.json"
project="demo-sikander"
if [ -z "${CI:-}" ]; then
  project="demo-g4-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
  free=($(node -e '
    const net = require("node:net")
    const servers = []
    const take = () => new Promise((ok) => { const s = net.createServer(); servers.push(s); s.listen(0, "127.0.0.1", () => ok(s.address().port)) })
    Promise.all([1, 2, 3, 4, 5].map(take)).then((ps) => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))).then(() => console.log(ps.join(" "))))'))
  config="$out/firebase.json"
  cat >"$config" <<JSON
{
  "firestore": { "rules": "$ROOT/firestore.rules" },
  "emulators": {
    "firestore": { "port": ${free[0]}, "host": "127.0.0.1", "websocketPort": ${free[1]} },
    "auth": { "port": ${free[2]}, "host": "127.0.0.1" },
    "hub": { "port": ${free[3]}, "host": "127.0.0.1" },
    "logging": { "port": ${free[4]}, "host": "127.0.0.1" },
    "ui": { "enabled": false }
  }
}
JSON
fi

echo "--- [3] the draft store, the citation gate, the override and approval, and the rules (emulators)"
npx firebase emulators:exec --config "$config" --only auth,firestore --project "$project" \
  "bash \"$ROOT/ci_gates/gate_g4_phase4a.sh\" --inner \"$out\""

echo "--- [4] functions lint, zero warnings"
npx eslint --max-warnings 0 functions

echo "--- [5] Gate G-2 over all routes"
bash "$ROOT/ci_gates/gate_g2.sh"

echo "=== Gate G-4 (Phase 4a): PASSED ==="
