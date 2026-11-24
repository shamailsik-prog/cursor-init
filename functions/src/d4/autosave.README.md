# L5.1 live draft autosave

Spec: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt` lines 3759–3792. The formal draft store (`drafts.ts`) keeps immutable `draft_versions` and emits `draft.autosaved` once per stored version. This module adds the high-frequency recovery timeline beside that store. It does not replace it.

## Flag

`SIKANDER_FLAG_D4_AUTOSAVE`. Unset means off. The value is trimmed and lower-cased and must be exactly `true`, the same rule as `services/d2-1/grammar.ts`. The flag is env-only. It is not registered in `platform/flags/featureFlags.ts` (a later integration PR owns the registry).

While the flag is off, `autosaveDraft`, `getRecoveryTimeline` and `restorePoint` return without reading or writing Firestore and without an audit row.

## Collection

`draft_autosave_points/{draftId}_{pointSeq}` with `pointSeq` padded to 10 digits, so a document-id range stays inside one draft and needs no composite index (`firestore.indexes.json` is not edited here). Firestore refuses a descending scan of that key, so the timeline reads the draft's points oldest-first and reverses them. A cursor document `{draftId}~head` (outside that range, not a recovery point) holds the last `pointSeq`, `clientSeq` and `bodyHash` so a new point does not scan the draft.

Each point, and the head cursor, holds `firmId`, `createdBy`, `matterId`, `draftId`, and the point also holds `pointSeq`, `clientSeq`, `bodyHash`, `body`, `createdAt`, `classification`, and `referencedByRestore` (false until a restore of that point commits). `createdBy` is the draft owner's uid (`draft.createdBy`, or the caller when the draft has none). `bodyHash` is the SHA-256 of the stored body, the same function as a version's `bodySha256`. The body is NFC-normalised and capped like a formal version (422 `unsupported_characters` or `draft_too_large`).

## Deletion

`infra/retention/inventory.json` registers `firestore:draft_autosave_points` as `matter_content` with key field `matterId`. The `pending` flag is off: this writer names the collection. A matter deletion (`functions/src/retention/saga.ts` `rowsQuery`) is `firmId` plus `matterId`. Every row carries `firmId` (L4), so that query stays inside the firm. It does not match a row whose `matterId` is null.

A pre-matter autosave stores `matterId: null`. W2-DEL finds it, and its head cursor, by `firmId` plus the owner key `createdBy` (`AUTOSAVE_OWNER_KEY`):

```
draft_autosave_points where firmId == <firm> and createdBy == <owner uid>
```

Keep the rows whose `matterId` is null. The same query also returns that owner's matter-attached points; `matterId === null` is the pre-matter cut, applied in memory so this wave adds no composite index. `draftId` is on every row, so one draft is `firmId` plus `draftId` as well. The head document id is `{draftId}~head` and it carries the same four fields.

`createDraft` still requires a matter. A draft that already has `matterId: null` can be autosaved by its owner when the caller's role would pass `draft.edit` (partner, associate, clerk) and the caller is cleared for the draft's label. There is no matter to be a member of. Any other caller gets 404 `not_found`. Restoring that point is 409 `matter_required`: a formal version is written through `storeVersion`, which names a matter.

## Calls

Permission is `draft.edit`, the guard `saveDraftVersion` uses (`loadDraftForCaller`, and `requireStillPermitted` inside a write). No new action. A missing draft, a draft in another firm, a draft above the caller's clearance, and a same-firm caller who is not a member of the matter are all 404 `not_found`. The response does not say which. A member refused by role (intern, client, accounts) still receives that role's 403, as the edit path does. A pre-matter draft (`matterId` null) is the same 404 unless the caller is its `createdBy`; the role refusal, when the caller is the owner, is still the `draft.edit` table.

`autosaveDraft(draftId, body, clientSeq, baseVersion)`

- `clientSeq` is a safe integer from 1. A seq less than or equal to the last point's seq is ignored (`stale_seq`): an offline replay does not insert a second point and does not move the timeline backwards.
- The same `bodyHash` as the last point writes nothing (`duplicate_body`), even when `clientSeq` is newer.
- `baseVersion` above the draft's current formal version is 409 `draft_changed`. A base behind the current version is still stored. A formal save landing in between must not drop the keystrokes.
- An approved or locked draft can still take points. The text is what must not be lost. Restoring it is what the lock refuses.
- Points are capped at 200 per draft (`AUTOSAVE_POINT_CAP`). On each new point, older points of **this draft** with `pointSeq <= newSeq - 200` are deleted when `referencedByRestore` is not true. Another draft is never in that query. A point a restore has referenced is kept even when it falls outside the window.

`getRecoveryTimeline(draftId, cursor, limit)`

- Newest `pointSeq` first. `limit` is 1 to 100, default 20. The cursor is the same opaque cursor as the other draft lists, and it must name one of this draft's point ids.
- The page is metadata (`pointSeq`, `clientSeq`, `bodyHash`, `createdAt`, `classification`). It does not carry the body.
- A point whose label is above the caller's clearance is left off the page.

`restorePoint(draftId, pointSeq)`

- Refuses an approved draft with 409 `draft_approved` and a locked draft with 409 `draft_locked`, before any version is written. The check runs again inside the version transaction.
- Otherwise calls `storeVersion` with kind `save` and the point's body under the draft's current title. That is the edit path: version `n+1`, a `draft.autosaved` event, one audit row, and `gateResult` cleared. `status`, `approvedBy` and `locked` move only as they do on an edit. The previous version documents are not updated.
- The point is marked `referencedByRestore` in that same transaction, including when the body already matches the current version and `storeVersion` writes no new version (`saved: false`).
- A missing point is 404 `point_not_found`.

## Classification

A point's `classification` is `raisedLabel`: the strictest of the draft's label and the matter's current label, which the caller must be cleared for. It is therefore never below the draft's label at the time of the write. When a later point's label is stricter, older points of the same draft are raised to it in that write. A point is never lowered if the draft's label later falls.

## Out of scope

`saveToMainFiles` (Document Vault, wave 2, after Q08). The client offline-sync UI (L9.5). HTTP routes and action registration (`functions/src/index.ts`, `functions/src/http/router.ts`, `platform/p5/actionRegistry.json`).
