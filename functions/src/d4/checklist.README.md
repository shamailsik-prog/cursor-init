# L5.4 filing checklist

Pure readiness for one document type. Spec lines 3865–3899. No Firestore, no route, no gate change.

## Calls

- `getChecklistForType(documentTypeId)` reads the verified row (`doctypes.ts`: posture, `annexureRule`, `checklist`) and returns that type's items, or `{ known: false }`.
- `getReadiness(documentTypeId, produced)` returns progress, the missing mandatory ids, and `readyToFile`.
- `blockIfIncomplete(documentTypeId, produced)` returns a refusal when a mandatory item is open. It is exported and not called from `gateOps.ts`. Wave 2 wires it with L4.1.

`produced` is an input, not a stored checklist: an affidavit id, annexure ids, a docket id, and manual ticks that each carry who (`by`) and when (`at`). A tick with a blank who or when does not count.

## What becomes an item

Only evidence on that row. There is no generic suit list for a type that names none of these.

| Item | Evidence on the row | Mandatory when | How it ticks |
| --- | --- | --- | --- |
| Pleading | Posture is writ, application, appeal, originating pleading, or responsive pleading | Always, for those postures | Manual tick |
| Annexures | Each certified copy, impugned order, judgment, decree, annexed document, record relied on, or annexure/exhibit line is its own item. A family rule is split on the same words | The item is not an explicit conditional. "if any", "where applicable" and "as applicable" stay optional. One item id ticks that item only | That item's id in `annexureIds`, or a manual tick |
| Verification | The row names an affidavit or a verification | The line is not an explicit conditional. "Affidavit if facts asserted" is mandatory. A family annexure rule does not override that line | Affidavit id, or a manual tick |
| Vakalatnama | A checklist line names it | The line has no bare "if". "Vakalatnama on file if counsel" stays optional | Manual tick |
| Index / docket | The row says indexed, index, or docket | The evidence is not conditional | Manual tick only |
| Court fee | A checklist line names the court fee | The line is not conditional | Manual tick only. The line is copied. No figure is computed (E-15, OR-3) |
| Other checklist lines | Whatever the slots did not take | Never. They stay visible so the row is not dropped | Manual tick |

An annexure id equals one item id. A second mandatory annexure stays open. "Death certificate annexed", "Certified copy of impugned order annexed" and "Certified copy of the order disobeyed" are each their own mandatory item. The Module 44 line "Impugned order date and limitation computed" stays optional: it is the limitation computation, not the certified copy. "FIR / complaint / judgment particulars as applicable" stays optional.

A notice, a memo, or a translation whose row names none of the slots is `{ known: false }` with reason `no_filing_profile` on readiness and on the refusal. An empty or whitespace id is `empty_document_type`. Any other unknown id, including a padded real id, is `unknown_type`. `readyToFile` is false in all three.

`NON_FORUM` does not by itself remove the pleading. A possession suit is still a pleading because its posture says so.

## Docket seam

`DOCKET_AUTO_TICK_WIRED` is false. L5.5 (open PR 248) owns the docket builder. Until that lands, a `docketId` does not tick the index. The index still closes with a manual tick that names who and when.

## Flag

`D4_CHECKLIST_FLAG` is `D4_CHECKLIST`. `SIKANDER_FLAG_D4_CHECKLIST` must be `true` (trim, case-insensitive) or `isD4ChecklistEnabled()` is false. The pure functions do not read the flag. Nothing on a route calls them, so the product surface stays off until wave 2.

## Out of scope

Persisted ticks (`markItemDone`), gate wiring, UI, court-fee arithmetic, stamp-duty arithmetic, and electronic filing.
