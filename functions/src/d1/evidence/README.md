# Module 4 — evidence register and chain of custody

Architecture lines 1189–1209. Per-matter evidence register and an append-only custody log. The original in `documents` is never written.

## Flag

`SIKANDER_FLAG_D1_EVIDENCE=true` turns the module on. Any other value, including unset, is off. A disabled call throws `feature_disabled` before a Firestore read. The flag is env-only. It is not registered in `platform/flags/featureFlags.ts`.

## Stores

`evidence_items` and `custody_events` are the pre-registered inventory rows (`matter_content`, deletion key `matterId`). They were never `pending`. This writer does not append a duplicate and does not add `pending`. Every evidence row and every custody event carries `firmId`. `infra/retention/inventory.json` is not edited. Client writes are denied: both collections are Functions-only (`allow create, update, delete: if false`). A partner token cannot plant an evidence row, forge a back-dated custody event, or pre-create the next seq. A read still requires a matter member cleared for that row, including a custody note.

## Custody hash

Logging an item writes the evidence row and a genesis custody event (`seq` 0) in one transaction. The genesis body hashes `item`, `source`, `receiptDate`, `classification`, `firmId`, and `matterId`. Its digest is stored as `headerHash` and, until the first custody event, as `lastHash`. Seq 1 uses that digest as `prevHash`. `createdBy` and `createdAt` are bound to the genesis `actorId` and `at`. `documentId` is bound to the last link event, and is null when the chain has no link.

For each later event, in a transaction:

1. Read the evidence row and every `custody_events` row for that item.
2. Refuse if `inspectCustodyChain` is not intact (`chain_broken`), including a missing tail, a count mismatch, or a `lastHash` that is not the tip.
3. `seq` is the verified `eventCount` plus one. The new id is created only; an existing seq is not reused.
4. `hash = sha256(canonicalJson(event without hash) + prevHash)` as lowercase hex. `canonicalJson` sorts keys. `prevHash` is inside the JSON and concatenated after it. `prevHash` is the header's `lastHash`.
5. `tx.create` the event at `${evidenceId}_${seq}` and, in that same transaction, set `eventCount`, `custodian`, and `lastHash`. `headerHash` does not change.

Concurrent appends contend on the evidence document and on that query, so two calls take seq 1 and seq 2.

`verifyCustodyChain` and `getCustodyTrail` read the header and the trail in one transaction (`loadCustody` passes the same transaction into both reads). The verdict is the first broken seq (`gap`, `count`, `duplicate`, `prev`, `hash`, `identity`, `header`, or `malformed`). A malformed document is listed on the trail and is not dropped. A direct edit of a bound header field, of `headerHash`, of `createdBy`, of `createdAt`, of `documentId`, or of `lastHash`, fails verify.

The chain is unkeyed. A direct database rewrite that recomputes every event hash, `headerHash`, and `lastHash` still verifies. The rules stop the client SDK from doing that. There is no caller-supplied idempotency key: a later `logEvidence` mints a new id and a new item.

A retry of the same attempt keeps the id and the timestamp already chosen. If that evidence row and its genesis are already this attempt's body, the call returns that item. If either document is present and is not that body, including a torn pair, the call throws `conflict` and writes nothing. The raw already-exists error does not escape, a second genesis is not appended, and the chain is not extended.

Condition notes, annotations, transfers, and the document link are new events. The evidence row may update only `custodian`, `eventCount`, `lastHash`, `documentId`, and a raised `classification`.

## Who may call

Writes: partner, associate, or clerk, same firm, member of the matter, clearance at or above the stored label. Reads add intern. Accounts and client are refused. The label stored on create is at least the matter's current label. A link stores a label at least the linked document's label, and never a lower one. A caller who is not a member is `not_member`. A tombstoned matter is `matter_deleted`. A matter row filed under another firm is `not_found`.

## Document link

`linkEvidenceToDocument` binds a document only when `readDocumentRecord` accepts it, the firm and matter match the evidence, and `canReadDocument` allows the caller. A different firm is `cross_firm`. A different matter, including a loose-vault `null`, is `cross_matter`. A document the caller may not read is `not_permitted`.

## Export

`exportEvidenceLog` reads the header and the trail through `getCustodyTrail` (one transaction) and returns canonical JSON, plain text, and the verdict. The report includes the genesis hash, the genesis `evidenceId`, `actorId`, `at`, `custodian`, and `note`, and every event hash. The same intact trail yields the same bytes. A chain that is not intact is refused with `chain_broken` and that verdict. No PDF library.

## Out of scope

Evidence chronology and brief generation, the splitter, live bucket proof, HTTP routes, and action-registry wiring.
