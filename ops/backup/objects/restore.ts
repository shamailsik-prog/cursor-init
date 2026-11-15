import { decryptDocumentObjectPayload } from "@/platform/documents/documentObjectStore"
import type { SpineStore } from "@/platform/spine/store"
import { isolationProblems } from "../drill/target"
import type { VersionedObjectAccess, ObjectVersionInfo, ResolvedObjectTarget } from "./s3"

export type RestoreRow = { id: string; firmId: string; storagePath: string; contentHash: string; key: string }

export type ObjectRestoreLocation = {
  kind: "local" | "temp"
  endpoint?: string
  root?: string
  bucket?: string
}

export type RestoreReport = { restored: string[]; unrecoverable: string[]; noop: boolean; refused: string[] }

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

async function readWriterTarget(access: VersionedObjectAccess): Promise<ResolvedObjectTarget | null> {
  if (typeof access.resolvedTarget !== "function") return null
  try {
    const reported = await access.resolvedTarget()
    if (!reported || typeof reported.endpoint !== "string" || typeof reported.bucket !== "string") return null
    return { endpoint: reported.endpoint.trim(), bucket: reported.bucket.trim() }
  } catch {
    return null
  }
}

async function versionIntact(
  access: VersionedObjectAccess,
  row: RestoreRow,
  version: ObjectVersionInfo,
  store: SpineStore,
  check?: (row: RestoreRow, body: Buffer) => Promise<boolean>
): Promise<boolean> {
  try {
    const body = await access.getVersion(row.key, version.versionId)
    return check ? await check(row, body) : await documentObjectIntegrityCheck(row, body, store)
  } catch {
    return false
  }
}

export async function restoreObjects(opts: {
  rows: RestoreRow[]
  source: VersionedObjectAccess
  target: VersionedObjectAccess
  store: SpineStore
  check?: (row: RestoreRow, body: Buffer) => Promise<boolean>
  location?: ObjectRestoreLocation
}): Promise<RestoreReport> {
  const writer = await readWriterTarget(opts.target)
  const refused = writer
    ? isolationProblems({ kind: "local", engine: "objects", endpoint: writer.endpoint, bucket: writer.bucket })
    : ["object writer did not report an endpoint and bucket"]
  if (writer && opts.location?.endpoint && opts.location.endpoint !== writer.endpoint) {
    refused.push("declared object location does not match the writer endpoint")
  }
  if (writer && opts.location?.bucket && opts.location.bucket !== writer.bucket) {
    refused.push("declared object location does not match the writer bucket")
  }
  if (refused.length) return { restored: [], unrecoverable: [], noop: false, refused }
  if (opts.rows.length === 0) {
    return {
      restored: [],
      unrecoverable: [],
      noop: false,
      refused: ["zero-unit object restore is not success"],
    }
  }

  const restored: string[] = []
  const unrecoverable: string[] = []
  for (const row of opts.rows) {
    const held = await opts.target.listVersions(row.key)
    const latest = held.filter((item) => item.isLatest === true)
    const current = latest.length === 1 ? latest[0] : undefined
    const already =
      current !== undefined &&
      !current.isDeleteMarker &&
      (await versionIntact(opts.target, row, current, opts.store, opts.check))
    if (already) continue
    const versions = await opts.source.listVersions(row.key)
    let picked: string | undefined
    for (const version of versions.filter((item) => !item.isDeleteMarker)) {
      const body = await opts.source.getVersion(row.key, version.versionId)
      const ok = opts.check ? await opts.check(row, body) : await documentObjectIntegrityCheck(row, body, opts.store)
      if (ok) {
        picked = version.versionId
        await opts.target.put(row.key, body)
        restored.push(row.id)
        break
      }
    }
    if (!picked) unrecoverable.push(row.id)
  }
  return { restored, unrecoverable, noop: restored.length === 0 && unrecoverable.length === 0, refused: [] }
}
