# L5.4 filing checklist

Pure readiness for one document type. Spec lines 3865–3899. No Firestore, no route, no gate change.

## Calls

- `getChecklistForType(documentTypeId)` reads the verified row (`doctypes.ts`: posture, `annexureRule`, `checklist`) and returns that type's items, or `{ known: false }`.
- `getReadiness(documentTypeId, produced)` returns progress, the missing mandatory ids, and `readyToFile`.
- `blockIfIncomplete(documentTypeId, produced)` returns a refusal when a mandatory item is open. It is exported and not called from `gateOps.ts`. Wave 2 wires it with L4.1.

`produced` is an input, not a stored checklist: an affidavit id, annexure ids, a docket id, and manual ticks that each carry who (`by`) and when (`at`). `at` must be a real ISO date in 1900 through 2100. The UTC year, month and day must be the numbers written in the string. A date-only value must equal `toISOString().slice(0, 10)`. `2026-02-30T00:00:00Z`, `2026-02-31`, `9999-12-31`, `0000-01-01` and `not-a-date` do not count. A not-applicable tick closes only an item marked conditional.

## What becomes an item

Only evidence on that row. There is no generic suit list for a type that names none of these.

| Item | Evidence on the row | Mandatory when | How it ticks |
| --- | --- | --- | --- |
| Pleading | Posture is writ, application, appeal, originating pleading, or responsive pleading | Always, for those postures | Manual tick |
| Annexures | Each certified copy, impugned order, judgment, decree, annexed document, or record relied on is its own item. A comma, " and ", or " / " splits a named line into one item per document. "judgment and warrant / jail roll" is three items (judgment, warrant, jail roll). A shared "Certified copy of" is copied onto each part. "and of …" stays on the previous document | Unconditional lines block. "if any", "where applicable" and "as applicable" block until the document is produced or a not-applicable tick records who and when. One annexure id ticks one item | That item's id in `annexureIds`, a manual tick, or a not-applicable tick when the item is conditional |
| Verification | The row names an affidavit or a verification | The line is not an explicit conditional. "Affidavit if facts asserted" is mandatory. A family annexure rule does not override that line | Affidavit id, or a manual tick |
| Vakalatnama | A checklist line names it | Always blocks. "Vakalatnama on file if counsel" is conditional: a not-applicable tick with who and when closes it | Manual tick, or a not-applicable tick when conditional |
| Index / docket | The row says indexed, index, or docket | The evidence is not conditional | Manual tick only |
| Court fee | A checklist line names the court fee | The line is not conditional | Manual tick only. The line is copied. No figure is computed (E-15, OR-3) |
| Other checklist lines | Whatever the slots did not take | A limitation line blocks until a real tick. "if delayed", "if any", "where applicable", "as applicable" and "if counsel" also block, and those explicit lines accept a not-applicable tick. An unconditional limitation line, including a suit check, a writ's laches line, and an appeal computation, rejects a not-applicable tick. Cause title, Gate 33, L17.1 and stamp duty do not block | Manual tick, or a not-applicable tick when the line is conditional |

An annexure id equals one item id. "Cheque, dishonour memo and notice annexed" is three items. "Impugned judgment and warrant / jail roll annexed" is three items. "Death certificate annexed", "Certified copy of impugned order annexed" and "Certified copy of the order disobeyed" are each their own mandatory item. A judgment line does not replace the certified copy of the impugned order. `at` must be a real ISO date in 1900 through 2100, and the UTC calendar day must match the string. "not-a-date", `2026-02-30T00:00:00Z`, `2026-02-31`, `9999-12-31` and `0000-01-01` are rejected. A not-applicable tick with a blank who or when is rejected, and so is a not-applicable tick on an item that is not conditional. Any statutory basis for these rows is **[REQUIRES VERIFICATION]**.

A notice, a memo, or a translation whose row names none of the slots is `{ known: false }` with reason `no_filing_profile` on readiness and on the refusal. An empty or whitespace id is `empty_document_type`. Any other unknown id, including a padded real id, is `unknown_type`. `readyToFile` is false in all three.

`NON_FORUM` does not by itself remove the pleading. A possession suit is still a pleading because its posture says so.

## Docket seam

`DOCKET_AUTO_TICK_WIRED` is false. L5.5 (open PR 248) owns the docket builder. Until that lands, a `docketId` does not tick the index. The index still closes with a manual tick that names who and when.

## Flag

`D4_CHECKLIST_FLAG` is `D4_CHECKLIST`. `SIKANDER_FLAG_D4_CHECKLIST` must be `true` (trim, case-insensitive) or `isD4ChecklistEnabled()` is false. The pure functions do not read the flag. Nothing on a route calls them, so the product surface stays off until wave 2.

## Out of scope

Persisted ticks (`markItemDone`), gate wiring, UI, court-fee arithmetic, stamp-duty arithmetic, and electronic filing.
