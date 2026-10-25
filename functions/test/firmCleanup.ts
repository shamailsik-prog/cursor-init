import type { DocumentReference } from "firebase-admin/firestore"
import { FieldPath } from "firebase-admin/firestore"
import { adminAuth, adminDb } from "../src/admin"

/**
 * Deletes what a test created for `firmIds` (and the auth users `uids`) from the shared emulator: every document of
 * every top-level collection whose `firmId` is one of them, every document whose id is a firm id or a uid or starts
 * with `{firmId}_` or `{uid}_` (the firm doc, its counters, its name index chunks, the users' rate-limit windows), and
 * the subcollections of the job rows. Returns the number of documents deleted.
 */
export async function deleteFirmData(firmIds: readonly string[], uids: readonly string[] = []): Promise<number> {
  const db = adminDb()
  const refs = new Map<string, DocumentReference>()
  const collections = await db.listCollections()
  for (const firmId of new Set(firmIds)) {
    for (const col of collections) {
      for (;;) {
        const page = await col.where("firmId", "==", firmId).select().limit(400).get()
        const fresh = page.docs.filter((d) => !refs.has(d.ref.path))
        for (const d of fresh) refs.set(d.ref.path, d.ref)
        if (page.size < 400 || fresh.length === 0) break
        await deleteAll([...refs.values()])
        refs.clear()
      }
    }
  }
  for (const id of new Set([...firmIds, ...uids])) {
    for (const col of collections) {
      const byId = await col.orderBy(FieldPath.documentId()).startAt(id).endAt(`${id}_\uf8ff`).select().get()
      for (const d of byId.docs) if (d.id === id || d.id.startsWith(`${id}_`)) refs.set(d.ref.path, d.ref)
    }
  }
  const all = [...refs.values()]
  for (const ref of all.filter((r) => r.parent.id === "jobs")) {
    for (const sub of await ref.listCollections()) {
      const docs = await sub.select().get()
      await deleteAll(docs.docs.map((d) => d.ref))
    }
  }
  await deleteAll(all)
  if (uids.length > 0) await adminAuth().deleteUsers([...uids])
  return all.length
}

/**
 * The cleanup for suites that leave tens of thousands of rows (the F42 saga's anonymised usage rows, vault tombstones
 * and acknowledgements): every document of every top-level collection whose `firmId` is one of `firmIds`, found with
 * one `in` query per collection per 30 firms, the firm docs themselves, and the auth users `uids`. Returns the number of
 * documents deleted.
 *
 * Unlike deleteFirmData it skips two sweeps that cost minutes at this volume on the emulator, which answers one query
 * at a time. The first is the per-id range scan of every collection for id-prefixed rows: still running after more
 * than 20 minutes with about 33,000 rows. The second lists every job row's subcollections: 171 job rows took 64 s, and
 * nothing in functions/src or the tests writes a subcollection under a job row. A user's rate-limit windows
 * (`rate_limits/{uid}_…`, which expire) are left in place.
 */
export async function deleteFirmScopedData(firmIds: readonly string[], uids: readonly string[] = []): Promise<number> {
  const db = adminDb()
  const ids = [...new Set(firmIds)]
  const refs = new Map<string, DocumentReference>()
  if (ids.length > 0) {
    for (const col of await db.listCollections()) {
      for (let i = 0; i < ids.length; i += 30) {
        const page = await col.where("firmId", "in", ids.slice(i, i + 30)).select().get()
        for (const d of page.docs) refs.set(d.ref.path, d.ref)
      }
    }
    for (const id of ids) {
      const firm = db.collection("firms").doc(id)
      refs.set(firm.path, firm)
    }
  }
  const all = [...refs.values()]
  await deleteAll(all)
  if (uids.length > 0) await adminAuth().deleteUsers([...new Set(uids)])
  return all.length
}

/**
 * The rows a test's users write with no firm (`firmId: ""`): the idempotency key and effect rows of a platform route
 * (ids `_nofirm_…`, field `uid`) and the audit rows of a refused or firm-less call (field `actorId`). Neither
 * deleteFirmData nor deleteFirmScopedData reaches them: their firmId names no firm and their ids carry no uid. Call it
 * before those, while `uids` still lists the test's users. Returns the number of documents deleted.
 */
export async function deleteFirmlessRowsOf(uids: readonly string[]): Promise<number> {
  const db = adminDb()
  const ids = [...new Set(uids)]
  const refs: DocumentReference[] = []
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30)
    for (const [collection, field] of [["idempotency_keys", "uid"], ["idempotency_effects", "uid"], ["audit_log", "actorId"]] as const) {
      const snap = await db.collection(collection).where("firmId", "==", "").where(field, "in", chunk).select().get()
      refs.push(...snap.docs.map((d) => d.ref))
    }
  }
  await deleteAll(refs)
  return refs.length
}

async function deleteAll(refs: readonly DocumentReference[]): Promise<void> {
  const db = adminDb()
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch()
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref)
    await batch.commit()
  }
}
