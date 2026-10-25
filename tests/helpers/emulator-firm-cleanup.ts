import type { DocumentReference } from "firebase-admin/firestore"
import { FieldPath } from "firebase-admin/firestore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"

/**
 * Firm cleanup for root emulator suites (audit F42's rule: an emulator e2e deletes its firms in afterAll), with the root
 * Admin SDK; `functions/test/firmCleanup.ts` is the Functions suites' copy. Finds what a test created for `firmIds` and
 * the auth users `uids` on the shared emulator: every document of every top-level collection whose `firmId` is one of
 * them, every document whose id is a firm id or a uid or starts with `{firmId}_` or `{uid}_`, and each firm document
 * with its subcollections.
 */
async function firmScopedRefs(firmIds: readonly string[], uids: readonly string[]): Promise<Map<string, DocumentReference>> {
  const db = adminDb()
  const refs = new Map<string, DocumentReference>()
  const ids = [...new Set(firmIds)]
  const collections = await db.listCollections()
  for (const col of collections) {
    for (let i = 0; i < ids.length; i += 30) {
      const page = await col.where("firmId", "in", ids.slice(i, i + 30)).select().get()
      for (const d of page.docs) refs.set(d.ref.path, d.ref)
    }
    for (const id of new Set([...ids, ...uids])) {
      const byId = await col.orderBy(FieldPath.documentId()).startAt(id).endAt(`${id}_`).select().get()
      for (const d of byId.docs) if (d.id === id || d.id.startsWith(`${id}_`)) refs.set(d.ref.path, d.ref)
    }
  }
  return refs
}

/** Deletes the firms' documents (firm documents recursively) and the auth users. Returns the documents deleted. */
export async function deleteFirmTestData(firmIds: readonly string[], uids: readonly string[] = []): Promise<number> {
  const db = adminDb()
  const refs = await firmScopedRefs(firmIds, uids)
  for (const id of new Set(firmIds)) {
    const firm = db.collection("firms").doc(id)
    refs.delete(firm.path)
    await db.recursiveDelete(firm)
  }
  const all = [...refs.values()]
  for (let i = 0; i < all.length; i += 400) {
    const batch = db.batch()
    for (const ref of all.slice(i, i + 400)) batch.delete(ref)
    await batch.commit()
  }
  const users = [...new Set(uids)]
  if (users.length > 0) {
    const res = await adminAuth().deleteUsers(users)
    if (res.failureCount > 0) throw new Error(`deleteFirmTestData: ${res.failureCount} auth user(s) not deleted`)
  }
  return all.length + firmIds.length
}

/** What is left of the firms after deleteFirmTestData: documents, firm-document subcollections and auth users. */
export async function remainingFirmTestData(firmIds: readonly string[], uids: readonly string[] = []): Promise<string[]> {
  const db = adminDb()
  const left = [...(await firmScopedRefs(firmIds, uids)).keys()]
  for (const id of new Set(firmIds)) {
    for (const sub of await db.collection("firms").doc(id).listCollections()) left.push(sub.path)
  }
  if (uids.length > 0) {
    const found = await adminAuth().getUsers([...new Set(uids)].map((uid) => ({ uid })))
    for (const u of found.users) left.push(`auth:${u.uid}`)
  }
  return left
}
