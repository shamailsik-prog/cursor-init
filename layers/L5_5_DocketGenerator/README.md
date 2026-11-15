# L5.5 Annexure Docket & Court-Format Builder (Q12a)

Pure in-memory generator. It is not mounted, and it does not call ingestion or the drafting factory.

## Flag

`L5_5_DOCKET_GENERATOR`, default **off**.

`SIKANDER_FLAG_L5_5_DOCKET_GENERATOR=true` turns it on. `false`, unset, or any other value stays off. The platform flag registry is a subset of `postgres/ddl/002_platform.sql`. This slice does not edit that DDL, so the flag is not inserted there.

With the flag off, `generateDocket` returns no PDF and no DOCX.

## What it does

Input is a filing set: draft body, the document type's `annexureRule` text, and ordered annexures carrying the existing annexure metadata fields (`artifactId`, `label`, `required`, `status`, `sourceRef`, optional `note`).

Output, only when the flag is on and nothing is queued:

- one PDF and one DOCX
- annexures numbered from the rule when the rule states a single series (`Annexure A, B, C` or `Enclosure 1, 2`); otherwise a person must set `assignedLabel`
- an index page whose page references are the annexure start pages
- odd-number pagination for legal-size court paper (printed 1, 3, 5, one number per leaf, blank verso, so each annexure starts on an odd page)
- sequential pagination for A4
- fixed document timestamps (`2026-01-01T00:00:00Z`)

## Wiring

| | |
|---|---|
| Reads from | The in-memory filing set passed by the caller. No folder, vault, or draft store. |
| Writes to | PDF and DOCX bytes on the return value. No table and no file. |
| Calls / triggers | None. `routes.ts` is not registered. |
| Flag | `L5_5_DOCKET_GENERATOR`, default off. `disable()` drops no subscriptions. |
| Core edits | None. |

## Ambiguity queue

Order, label, or reference that the rule and the filing set do not settle is queued (`order_unresolved`, `label_unresolved`, `ref_unresolved`). The generator does not reorder, pick between `A, B, C` and `P/1`, or invent a page size. An assigned label on a two-scheme rule is the human's choice of series; a body citation that is not one of those labels is still queued. Final PDF and DOCX are refused.

DOCX created and modified stamps, and zip entry times, are fixed. Text in the draft and the annexures is left as written.

`migration.sql` is not applied and creates nothing.

## Residuals

Clerk acceptance of a real filing set is not done. The PDF uses the built-in Times-Roman face (no embedded Times New Roman file and no network). The DOCX names Times New Roman for the word processor. There is no electronic filing and no fee memo.
