import type { Firestore as AdminFirestore } from "firebase-admin/firestore"
import {
  collection as clientCollection,
  doc as clientDoc,
  getDoc as clientGetDoc,
  getDocs as clientGetDocs,
  runTransaction as clientRunTransaction,
  setDoc as clientSetDoc,
  updateDoc as clientUpdateDoc,
  deleteDoc as clientDeleteDoc,
  type Firestore as ClientFirestore,
} from "firebase/firestore"

export type Firestore = ClientFirestore | AdminFirestore

function isAdminFirestore(db: unknown): db is AdminFirestore {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as AdminFirestore).collection === "function"
  )
}

function isClientFirestore(db: unknown): db is ClientFirestore {
  return typeof db === "object" && db !== null && !isAdminFirestore(db)
}

export function collection(db: ClientFirestore | AdminFirestore, path: string) {
  if (isAdminFirestore(db)) return db.collection(path)
  return clientCollection(db, path)
}

export function doc(
  db: ClientFirestore | AdminFirestore,
  collectionPath: string,
  documentId?: string
) {
  if (isAdminFirestore(db)) {
    if (documentId !== undefined) return db.collection(collectionPath).doc(documentId)
    return db.doc(collectionPath)
  }
  return clientDoc(db, collectionPath, documentId!)
}

export async function getDoc(ref: ReturnType<typeof doc>) {
  if ("get" in ref && typeof ref.get === "function") {
    const snap = await ref.get()
    return {
      exists: () => snap.exists,
      data: () => snap.data(),
      id: snap.id,
    }
  }
  return clientGetDoc(ref as never)
}

export async function getDocs(query: ReturnType<typeof collection>) {
  if ("get" in query && typeof query.get === "function") {
    const snap = await query.get()
    return {
      docs: snap.docs.map((row) => ({
        id: row.id,
        data: () => row.data(),
      })),
      empty: snap.empty,
    }
  }
  return clientGetDocs(query as never)
}

export async function setDoc(ref: ReturnType<typeof doc>, data: unknown) {
  if ("set" in ref && typeof ref.set === "function") {
    await ref.set(data as Record<string, unknown>)
    return
  }
  await clientSetDoc(ref as never, data as never)
}

export async function updateDoc(ref: ReturnType<typeof doc>, data: unknown) {
  if ("update" in ref && typeof ref.update === "function") {
    await ref.update(data as Record<string, unknown>)
    return
  }
  await clientUpdateDoc(ref as never, data as never)
}

export async function deleteDoc(ref: ReturnType<typeof doc>) {
  if ("delete" in ref && typeof ref.delete === "function") {
    await ref.delete()
    return
  }
  await clientDeleteDoc(ref as never)
}

export async function runTransaction<T>(
  db: ClientFirestore | AdminFirestore,
  fn: (tx: {
    get: (ref: ReturnType<typeof doc>) => Promise<{ exists: () => boolean; data: () => unknown }>
    set: (ref: ReturnType<typeof doc>, data: unknown) => void
    update: (ref: ReturnType<typeof doc>, data: unknown) => void
  }) => Promise<T>
): Promise<T> {
  if (isAdminFirestore(db)) {
    return db.runTransaction(async (tx) => {
      const wrap = {
        get: async (ref: ReturnType<typeof doc>) => {
          const snap = (await tx.get(ref as never)) as unknown as {
            exists: boolean
            data: () => Record<string, unknown> | undefined
          }
          return { exists: () => snap.exists, data: () => snap.data() }
        },
        set: (ref: ReturnType<typeof doc>, data: unknown) => {
          tx.set(ref as never, data as Record<string, unknown>)
        },
        update: (ref: ReturnType<typeof doc>, data: unknown) => {
          tx.update(ref as never, data as never)
        },
      }
      return fn(wrap)
    })
  }
  return clientRunTransaction(db, fn as never)
}

export function assertKnownFirestore(db: unknown): ClientFirestore | AdminFirestore {
  if (isAdminFirestore(db) || isClientFirestore(db)) return db
  throw new Error("unsupported Firestore database instance")
}
