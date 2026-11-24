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
| Calls / triggers | None. `routes.ts` is not registered. A mount requires a P5 `decide()` guard. |
| Flag | `L5_5_DOCKET_GENERATOR`, default off. `disable()` drops no subscriptions. |
| Core edits | None. |

## Ambiguity queue

Anything the rule and the filing set do not settle is queued. The codes are `order_unresolved`, `label_unresolved`, `ref_unresolved`, `unfiled_label`, and `ambiguous_label`. The generator does not reorder, pick between `A, B, C` and `P/1`, or invent a page size. Final PDF and DOCX are both absent when the queue is not empty, and both present when it is empty.

The order check uses the citation grammar. It compares first occurrences and does not read the fail-closed label scan. A pure index of filed labels with descriptions, including a reversed one, stays out of the order check. A heading remainder that cites those labels (`see`, `refer`, `relies`, `placed`) or a sentence such as `the witness proved` is narrative, and the order check applies. `P/01` is not `P/1`. An assigned label on a two-scheme rule must be one series. An annexure whose status is `pending` or `blocked` is queued.

The fail-closed scan tokenises the whole body after NFKC and dash folding. A token is a single capital that is not glued to a letter or a digit, a capital plus `-`, `/`, or `.` and digits (optional glued letter, `(letter)`, `/letter`, or `/digits`), a word path such as `deed/P/9` or `sale-deed/P-9`, a same-line range `A-d` or `A to D`, or a list of those tokens such as `D and E`. A word of two or more letters is not a token. A lower-case word is not a token. Every token has to be one of the filing set's own tokens. A missing token is `unfiled_label` and the detail quotes it, for example `unfiled label "D"` or `unfiled label "P-9"`. A mark whose digits are followed by a letter, `(letter)`, or `/letter`, and whose compound key is not filed, is `ambiguous_label` and the detail quotes the compact surface, for example `ambiguous label "P-1/A"`. A range expands and each missing letter is quoted on its own. A heading does not authorise a token. The only headings recognised as index headings are `LIST OF ANNEXURES`, `LIST OF EXHIBITS`, `LIST OF DOCUMENTS`, `LIST OF ANNEXURE`, `LIST OF ENCLOSURES`, `INDEX`, `INDEX OF ANNEXURES`, and `INDEX OF DOCUMENTS`. `SCHEDULE OF ANNEXURES` is not one of them. Numbered lines, bullets, dates, pipe rows, `see below`, `as placed on record`, and `refer para` do not authorise a token either.

The only spans removed before that scan are `C.P. No. X-n of YYYY` (dots optional), `Suit No. n of YYYY` with a numeric `n`, `u/s n CPC` or `u/s n PPC`, and `Ex parte`. `Suit No. D-12 of 2020`, `A.D. 2020`, `C.P. No. D-1234/2025`, an address mark such as `Plot P-12` or `D-45/2`, and a bare capital such as `I` or `D` are tokens and are refused when they are not in the filing set.

The citation grammar still runs beside that scan. Its position words (`on`, `upon`, `to`, `also`, `filed`, `herewith`, `thereto`, `above`, `below`, `attached`, `annexed`, `hereto`) only delay a label or fill an empty slot. They do not exempt a token from the fail-closed scan. A lowercase `p.` or `pp.` plus a number is a page reference for that grammar. `AIR` plus a year is a law report for that grammar. Those exemptions are not a second allowlist for the fail-closed scan.

DOCX created and modified stamps are fixed. Zip entry times use local midnight on 2026-01-01 so the bytes do not depend on the time zone. Text in the draft and the annexures is left as written. Each plan page is its own section, with the PDF page size, the content-box margins, exact line spacing, and a PAGE field on a content leaf. Within a section, each source paragraph is one paragraph and reflows; the file does not contain a line break per wrapped line. Lines are measured with Times New Roman (Tinos) widths and broken at 97% of the measure.

`routes.ts` is not mounted. A later mount needs a P5 `decide()` guard in front of the route.

`migration.sql` is not applied and creates nothing.

## Residuals

Clerk acceptance of a real filing set is not done. The PDF still draws the built-in Times-Roman face. Wrapping uses embedded Tinos advance widths, which match Times New Roman, plus a 3% slack, so a reflowing Times New Roman paragraph stays inside the measure. There is no embedded font file and no network. Schedule numerals are not a citation keyword. There is no electronic filing and no fee memo.
