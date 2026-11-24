# Loose files vault (L4.5, Erratum E-18)

Files the firm holds before they are a matter live on the existing `documents` rows with `matterId: null`. This module adds no collection. It stores recall tags on `looseTags`, attaches a row to one matter, and reports the 30-day hold. It never deletes a document.

The original L4.5 line that gave every user access is overridden by E-18: only a clerk or a partner whose clearance is at least confidential. That check is `canUseLooseVault` and `canReadDocument` in `platform/p5/documentAccess.ts`. Those files are not edited here. A row above the caller's clearance is not found. A cross-firm id is not found, and the error is only `not_found`.

The feature flag is `SIKANDER_FLAG_L4_LOOSE_VAULT`. Unset, blank, or anything other than `true` (trim, then lower-case) is off. While it is off every function throws `feature_disabled` before a Firestore read. `feature_disabled` is not an upload block. The vault is off, and the upload path must not treat that throw as "blocked".

## Upload block, per uploader

E-18 and W-13 say a 30-day hold escalates and blocks further uploads, and never deletes. They do not name the subject of the block. `isLooseUploadBlocked(firmId, uploaderId, now)` takes both ids, so the block is **per uploader** inside that firm.

A firm-wide block was the other reading (W-13: "blocks further uploads to the vault"). It was not taken. One clerk's aged file would stop every clerk and partner, and `uploaderId` would do no work. The hold that has to stop is the person who keeps parking files and uploading more. Escalation still lists every aged loose file the caller may see, so the firm can see the hold. Another firm's rows are not scanned. A colleague's aged file does not block this uploader.

The holder is `uploadedBy`. The predicate is true when that person has a loose row in the firm whose age is at least 30 days of 24 hours (`30 * 24 * 60 * 60 * 1000`, not a calendar month) and a partner has not acknowledged it. Age is `now` minus `createdAt`. Exactly 30d00h is due. 29d23h is not. A loose row with no readable `createdAt` is treated as overdue, so an undated hold cannot skip the rule.

Search, list and escalation query `firmId` and `matterId == null` together. The upload block adds `uploadedBy`. None of them downloads the firm's matter-bound archive and drops those rows afterwards. Each read is at most 100 documents, ordered by document id, and the walk continues until the query is exhausted so a hold on a later page is still seen. Clearance is applied to each loose row before it is returned. A row above the caller is omitted.

Converted rows have a matter id, so the loose query does not return them, and they do not count toward the block or the escalation list. Acknowledgement is `loosePartnerAck` (`partnerId`, `acknowledgedAt`). Firestore rules reject that field on every client create and update. `acknowledgeLooseHold` is the writer. It is partner-only, it stores `partnerId` as the caller's own uid and `acknowledgedAt` as the supplied instant, and it audits `loose_vault.acknowledge`. A clerk is refused with `partner_only` before any read. Acknowledgement lifts the block for that row and leaves the row on the escalation list with `acknowledged: true`. It does not change `matterId` or classification. A partner may acknowledge their own hold: E-18 says "a partner", not a different partner.

A client create of a loose row must set `uploadedBy` to the signed-in uid and `createdAt` to the server time. A client update cannot change `uploadedBy`, `createdAt` or `loosePartnerAck`. That stops a clerk resetting the clock, moving the hold onto a colleague, or forging an acknowledgement. A client update that sets `sourceChannel`, `byteSize`, `mimeType`, `objectVersion` or `objectBytesStatus` must leave a canonical value. The Admin SDK, which these functions use, is not subject to those rules.

A loose row the query returns that `readDocumentRecord` refuses still counts. It blocks that uploader unless a partner acknowledgement is already on the row, and it stays on the escalation list with `malformed: true`. Clearance still applies: an unknown or higher label is not shown to a caller who does not cover it. A confidential clerk does not see a privileged overdue row.

`isLooseUploadBlocked` is exported for W1-L91. This module does not call the upload path.

## Convert

`convertToMatter` sets `matterId` in one transaction, from null to that matter, for a member of the matter who also meets the E-18 rule and whose clearance covers the matter's label. The same target again is `alreadyConverted` and does not rewrite the row. A different matter is `convert_target_conflict`. A caller who is not a member gets `not_a_member`. A member whose clearance is below the matter gets `exceeds_own_clearance`. A missing or other-firm matter is `not_found`.

The update writes `matterId` and no other document field. Classification cannot move down, and it is not raised to the matter. After the attach, read access still requires clearance for the matter, so leaving the old label in place does not widen who can read the file.

## Out of scope

Wiring the block into uploads, notifying anyone about an escalation, routes, actions, and UI. Wave 2 owns those. No new store, no registry bump (`documents` is not a conflict-registry collection), no deletion.
