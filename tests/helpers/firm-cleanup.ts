import type { DocumentReference } from "firebase-admin/firestore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"

/**
 * The root suites' cleanup for an emulator e2e, after functions/test/firmCleanup.ts `deleteFirmScopedData` (audit F42):
 * every document of every top-level collection whose `firmId` is one of `firmIds` (one `in` query per collection per
 * 30 firms), the firm documents themselves, each extra document `paths` names (a nested document a firm-scoped query
 * cannot reach), and the auth users `uids`. It then counts what is still there under those firms and paths and returns
 * it, so the suite can assert that its cleanup left nothing.
 */
export async function deleteFirmRows(input: {
  firmIds: Iterable<string>
  uids?: Iterable<string>
  paths?: Iterable<string>
}): Promise<{ deleted: number; remaining: number }> {
  const db = adminDb()
  const firmIds = [...new Set(input.firmIds)]
  const uids = [...new Set(input.uids ?? [])]
  const paths = [...new Set(input.paths ?? [])]
  const refs = new Map<string, DocumentReference>()
  const scan = async (): Promise<void> => {
    refs.clear()
    const collections = await db.listCollections()
    for (let i = 0; i < firmIds.length; i += 30) {
      const chunk = firmIds.slice(i, i + 30)
      for (const col of collections) {
        const page = await col.where("firmId", "in", chunk).select().get()
        for (const d of page.docs) refs.set(d.ref.path, d.ref)
      }
    }
    for (const id of firmIds) {
      const firm = db.collection("firms").doc(id)
      if ((await firm.get()).exists) refs.set(firm.path, firm)
    }
    for (const path of paths) {
      const ref = db.doc(path)
      if ((await ref.get()).exists) refs.set(ref.path, ref)
    }
  }
  await scan()
  const all = [...refs.values()]
  for (let i = 0; i < all.length; i += 400) {
    const batch = db.batch()
    for (const ref of all.slice(i, i + 400)) batch.delete(ref)
    await batch.commit()
  }
  if (uids.length > 0) await adminAuth().deleteUsers(uids)
  await scan()
  return { deleted: all.length, remaining: refs.size }
}
