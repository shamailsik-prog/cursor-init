import { decryptDocumentObjectPayload } from "@/platform/documents/documentObjectStore"
import type { SpineStore } from "@/platform/spine/store"
import type { VersionedObjectAccess, ObjectVersionInfo } from "./s3"

export type RestoreRow = { id: string; firmId: string; storagePath: string; contentHash: string; key: string }

export type RestoreReport = { restored: string[]; unrecoverable: string[]; noop: boolean }

export async function documentObjectIntegrityCheck(
  row: RestoreRow,
  body: Buffer,
  store: SpineStore
): Promise<boolean> {
  try {
    const plaintext = decryptDocumentObjectPayload(body)
    return store.hashKey(row.firmId, plaintext) === row.contentHash
  } catch {
    return false
  }
}

export async function pickIntactVersion(
  versions: ObjectVersionInfo[],
  read: (v: ObjectVersionInfo) => Promise<Buffer>,
  check: (body: Buffer) => Promise<boolean>
): Promise<string | undefined> {
  const sorted = [...versions].filter((v) => !v.isDeleteMarker).reverse()
  for (const v of sorted) {
    try {
      const body = await read(v)
      if (await check(body)) return v.versionId
    } catch {
      continue
    }
  }
  return undefined
}

export async function restoreObjects(opts: {
  rows: RestoreRow[]
  source: VersionedObjectAccess
  target: VersionedObjectAccess
  store: SpineStore
  check?: (row: RestoreRow, body: Buffer) => Promise<boolean>
}): Promise<RestoreReport> {
  const restored: string[] = []
  const unrecoverable: string[] = []
  for (const row of opts.rows) {
    const versions = await opts.source.listVersions(row.key)
    let picked: string | undefined
    for (const v of versions.filter((x) => !x.isDeleteMarker)) {
      const body = await opts.source.getVersion(row.key, v.versionId)
      const ok = opts.check ? await opts.check(row, body) : await documentObjectIntegrityCheck(row, body, opts.store)
      if (ok) {
        picked = v.versionId
        const bytes = body
        await opts.target.put(row.key, bytes)
        restored.push(row.id)
        break
      }
    }
    if (!picked) unrecoverable.push(row.id)
  }
  return { restored, unrecoverable, noop: restored.length === 0 }
}
