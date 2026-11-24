# Module 4 — evidence register and chain of custody

Architecture lines 1189–1209. Per-matter evidence register and an append-only custody log. The original in `documents` is never written.

## Flag

`SIKANDER_FLAG_D1_EVIDENCE=true` turns the module on. Any other value, including unset, is off. A disabled call throws `feature_disabled` before a Firestore read. The flag is env-only. It is not registered in `platform/flags/featureFlags.ts`.

## Stores

`evidence_items` and `custody_events` are the pre-registered inventory rows (`matter_content`, deletion key `matterId`). They were never `pending`. This writer does not append a duplicate and does not add `pending`. Every evidence row and every custody event carries `firmId`. Firestore rules and `infra/retention/inventory.json` are not edited.

## Custody hash

For each event, in a transaction:

1. Read the evidence row and every `custody_events` row for that item.
2. Refuse if `inspectCustodyChain` is not intact (`chain_broken`).
3. `seq` is the verified length plus one. Seq 1 uses `prevHash` `""`.
4. `hash = sha256(canonicalJson(event without hash) + prevHash)` as lowercase hex. `canonicalJson` sorts keys. `prevHash` is inside the JSON and concatenated after it.
5. `tx.create` the event at `${evidenceId}_${seq}`. The event is never updated or deleted by this module.

Concurrent appends contend on the evidence document and on that query, so two calls take seq 1 and seq 2.

`verifyCustodyChain` recomputes the chain and returns the first broken seq (`gap`, `duplicate`, `prev`, `hash`, `identity`, or `malformed`). The evidence header (`item`, `source`, `receiptDate`) is not inside that hash. The module has no writer for those fields. A direct store edit of the header is not what `verifyCustodyChain` reports.

Condition notes, annotations, transfers, and the document link are new events. The evidence row may update only `custodian`, `eventCount`, `documentId`, and a raised `classification`.

## Who may call

Writes: partner, associate, or clerk, same firm, member of the matter, clearance at or above the stored label. Reads add intern. Accounts and client are refused. The label stored on create is at least the matter's current label. A link stores a label at least the linked document's label, and never a lower one.

## Document link

`linkEvidenceToDocument` binds a document only when `readDocumentRecord` accepts it, the firm and matter match the evidence, and `canReadDocument` allows the caller. A different firm is `cross_firm`. A different matter, including a loose-vault `null`, is `cross_matter`. A document the caller may not read is `not_permitted`.

## Export

`exportEvidenceLog` returns canonical JSON and plain text for the stored trail, in seq order, including every `hash` and `prevHash`. The same trail yields the same bytes. No PDF library.

## Out of scope

Evidence chronology and brief generation, the splitter, live bucket proof, HTTP routes, and action-registry wiring.
