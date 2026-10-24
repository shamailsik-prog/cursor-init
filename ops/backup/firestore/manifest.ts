import type { CollectionReference, Firestore } from "firebase-admin/firestore"
import { MultisetDigest } from "../lib/digest"
import { diffRecords, diffSets } from "../lib/diff"
import { canonicalEncode, collectionPattern, docHash } from "./canonical"
import { runRelationshipChecks, type FirestoreIndex } from "./relationships"

export type CollectionDigest = { count: number; digest: string }
export type FirestoreManifest = {
  collections: Record<string, CollectionDigest>
  firms: Record<string, Record<string, CollectionDigest>>
  relationships: Record<string, { count: number }>
}

async function visitCollection(db: Firestore, index: FirestoreIndex, col: CollectionReference): Promise<void> {
  const docs = await col.listDocuments()
  for (const ref of docs) {
    const snap = await ref.get()
    if (snap.exists) index.set(ref.path, { path: ref.path, data: snap.data() as Record<string, unknown> })
    const subs = await ref.listCollections()
    for (const sub of subs) await visitCollection(db, index, sub)
  }
}

export async function buildIndex(db: Firestore): Promise<FirestoreIndex> {
  const index: FirestoreIndex = new Map()
  for (const col of await db.listCollections()) await visitCollection(db, index, col)
  return index
}

export async function collectFirestoreManifest(db: Firestore): Promise<FirestoreManifest> {
  const index = await buildIndex(db)
  const collections: Record<string, CollectionDigest> = {}
  const firms: Record<string, Record<string, CollectionDigest>> = {}
  const byPattern = new Map<string, { digest: MultisetDigest; firmBuckets: Map<string, MultisetDigest> }>()

  for (const doc of index.values()) {
    const pattern = collectionPattern(doc.path)
    let bucket = byPattern.get(pattern)
    if (!bucket) {
      bucket = { digest: new MultisetDigest(), firmBuckets: new Map() }
      byPattern.set(pattern, bucket)
    }
    const h = docHash(doc.path, doc.data)
    bucket.digest.add(h)
    const firm = typeof doc.data.firmId === "string" ? doc.data.firmId : "(none)"
    let fd = bucket.firmBuckets.get(firm)
    if (!fd) {
      fd = new MultisetDigest()
      bucket.firmBuckets.set(firm, fd)
    }
    fd.add(h)
  }

  for (const [pattern, bucket] of byPattern) {
    collections[pattern] = { count: bucket.digest.count, digest: bucket.digest.digest() }
    firms[pattern] = {}
    for (const [firm, d] of bucket.firmBuckets) {
      firms[pattern][firm] = { count: d.count, digest: d.digest() }
    }
  }

  const rel = runRelationshipChecks(index)
  const relationships: Record<string, { count: number }> = {}
  for (const [k, v] of Object.entries(rel)) relationships[k] = { count: v.count }

  return { collections, firms, relationships }
}

export function compareFirestoreManifests(expected: FirestoreManifest, actual: FirestoreManifest): string[] {
  const lines: string[] = []
  lines.push(...diffRecords("collections", expected.collections, actual.collections))
  lines.push(...diffRecords("firms", expected.firms, actual.firms))
  lines.push(...diffRecords("relationships", expected.relationships, actual.relationships))
  return lines
}
