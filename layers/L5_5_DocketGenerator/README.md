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

Order, label, or reference that the rule and the filing set do not settle is queued (`order_unresolved`, `label_unresolved`, `ref_unresolved`). The generator does not reorder, pick between `A, B, C` and `P/1`, or invent a page size. Citations and assigned labels are read by one normaliser and one label grammar. The normaliser applies NFKC, folds a carriage return, line separator, or paragraph separator to a newline, rejoins a hyphen split by a newline or a blank line, and treats one newline as a space. A blank line ends a sentence except after `and`, a comma, `to`, a hyphen, a slash, or a citation keyword, and except immediately before `and` or `or` plus a single-letter label. `see`, `refer`, and `relies` open a citation for a single uppercase letter, a P, D, or R mark, an Annexure, Exhibit, Enclosure, or Mark head, or a bare letter after `on`, `upon`, or `also`. A bare head followed only by lower-case words is prose. A fixed set of position words (`on`, `upon`, `to`, `also`, `filed`, `herewith`, `thereto`, `above`, `below`, `attached`, `annexed`, `hereto`) only delays a label or fills an empty slot. A lower-case word is not a label because it is lower case, not because of which verb follows the head. A single letter outside A–Z is a label when it sits in a label slot, and it is refused when that label is not filed. A word whose period is followed by a label-shaped token is a citation and is refused when the label is not filed. café is not a label slot. A vertical tab, form feed, or next-line character is a newline. A lowercase `p.` or `pp.` plus a number is a page reference. `No.` plus a letter-dash-digits code is a case number when `of YYYY` or `/YYYY` follows. `AIR` plus a year is a law report. A heading is `list` or `index` of exhibits, annexures, documents, the singular `annexure`, or `enclosures`, or a bare `index`, in any case, with markdown, a number, a bullet, a colon, a tab, or a period ignored. Each index line is checked on its own: a numbered line, a bulleted line, a dated line, a pipe row, and a line that says `see below`, `as placed on record`, or `refer para` still contributes its labels. A heading or index label, including a pipe cell and a dash or colon line, is checked against the same filing set as a body reference. A pure index, including a reversed list of filed labels with descriptions, is left out of the order check. A heading remainder that contains see, refer, relies, or placed as a citation of those labels, or a sentence such as `the witness proved`, is narrative, and the order check applies. A label slot is an upper-case A–Z token, a one-letter token, a short mixed token, or a P-n, D-n, or R-n mark after Annexure, Exhibit, Mark, Annex, Encl, or Doc, in any case, and each later item joined by a comma, and, or, &, |, /, or a hyphen. A lower-case word of three or more letters is not a label. A slot token that is not in the filing set is refused. After a head, a word with a trailing period followed by a label-shaped token is refused. A token that is not label-shaped is not refused. A trailing etc. with no label after it generates. `A, B, C etc., D` refuses because D is not filed. A word outside a label slot is cited when the filing index assigns that word. Marks in a pure heading index are citations and are left out of the order check. Two or more ordered citations must follow the filing-set order. Manual exhibit order is read by `checkManualRefs` from the same scan. Lists, Oxford commas, and known ranges are read through to the last label. Every label has to belong to that filing's own scheme, so an Annexure citation on an enclosure filing is unresolved. A P, D, or R mark is a label when it is P-n, D-n, or R-n in any punctuation, including `Document No. P-9`, `document P-9`, `deed/P/9`, and `sale-deed/P-9`. `P-1A`, `P-1/A`, and `P-1(a)` are not the filed mark `P-1`. A case number such as C.P. No. D-1234 of 2023, Suit No. 12 of 2020, and Suit No. D-12 of 2020, an address such as Plot P-12, `A.D. 2020`, and `u/s 80 CPC` after a dash, is not a label. `P/01` is not `P/1`. An assigned label on a two-scheme rule must be one series; mixing letters with P, D or R marks is queued. An annexure whose status is `pending` or `blocked` is queued. Final PDF and DOCX are refused.

DOCX created and modified stamps are fixed. Zip entry times use local midnight on 2026-01-01 so the bytes do not depend on the time zone. Text in the draft and the annexures is left as written. Each plan page is its own section, with the PDF page size, the content-box margins, exact line spacing, and a PAGE field on a content leaf. Within a section, each source paragraph is one paragraph and reflows; the file does not contain a line break per wrapped line. Lines are measured with Times New Roman (Tinos) widths and broken at 97% of the measure.

`routes.ts` is not mounted. A later mount needs a P5 `decide()` guard in front of the route.

`migration.sql` is not applied and creates nothing.

## Residuals

Clerk acceptance of a real filing set is not done. The PDF still draws the built-in Times-Roman face. Wrapping uses embedded Tinos advance widths, which match Times New Roman, plus a 3% slack, so a reflowing Times New Roman paragraph stays inside the measure. There is no embedded font file and no network. Schedule numerals are not a citation keyword. There is no electronic filing and no fee memo.
