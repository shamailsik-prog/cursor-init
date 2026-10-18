import { FieldValue, type DocumentData, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"

/**
 * The firm's conflict-registry version (Bugbot PR #8; spec P2-6, P2-30). `openMatter` re-screens a
 * check before its transaction; this counter makes that screen consistent with the transaction. Every
 * write that changes what the screen consumes (what `loadRegistry` reads, and since F37 the conflict name
 * index) bumps it in that write's own transaction:
 *
 * - registerClient: `clients` (+ `entities`), candidate `entity_links`, and the client's name in the index;
 * - openMatter: `matters` and `matter_parties`, and the opposing names the index lacks;
 * - closeMatter: `matters.status` and `matter_parties.matterStatus`;
 * - confirmMerge, disputeLink, rejectLink: `entity_links` state;
 * - unmergeEntity and the un-merge saga jobs (`d1.unmerge.links`, `d1.unmerge.checks`): `entity_links` state;
 * - the auto-confirm job (`d1.autoconfirm`): `entity_links` state;
 * - the name index reconciliation (`d1.conflict.reindex`): the index's chunks and state.
 *
 * Audit F37: the doc also holds the name index state (`nameIndex = { schema, version, chunk, bytes }`,
 * `conflict/nameIndex.ts`). Every bump moves `nameIndex.version` with `version`, so the index reads current
 * exactly while every registry write goes through `bumpRegistryVersion`; a write that bumps the version
 * alone (an older instance during a deploy, a manual edit) leaves the index stale and the screen refuses.
 * One read of this doc gives the screen its version and the index state together.
 *
 * Not bumped: advanceStage (writes `matters.stage`, which the screen never reads); the `firms` doc
 * writers (prefixes, MFA policy, onboarding: fields the screen never reads; `featureFlags.L17_2_ENABLED`
 * has no writer in functions/src); `transliteration_map` (no writer in functions/src).
 *
 * Enforced at test time (spec P3-20): `REGISTRY_SCOPE` below names what `loadRegistry` reads (with
 * `PROJECTION_SCOPE`, the name index chunks), and the vitest setup file
 * `functions/test/setup/registryWriteRecorder.ts` fails any functions test in which code under
 * functions/src writes an in-scope field of those collections in a transaction that stages no bump (or
 * writes one outside a transaction), or creates a named client or opposing party without the index-aware
 * bump of `stageRegistryWrite`. `p2.registry-discipline.emu.test.ts` proves the recorder reports both and
 * that `loadRegistry` reads exactly `REGISTRY_SCOPE`.
 *
 * The doc lives with the other per-firm counters, `counters/{firmId}_registry` (server-only under
 * firestore.rules: `counters` denies every client read and write). The bump is a blind
 * `FieldValue.increment` write, so it needs no read and may sit anywhere among a transaction's writes;
 * the writers that add names read the doc first (`readRegistryStateTx`) for the index's open chunk.
 */

/** A collection's registry scope: every field, every field but some, or only some (top-level names). */
export type RegistryFieldScope = { all: true } | { except: readonly string[] } | { only: readonly string[] }

/**
 * The collections `loadRegistry` reads, with the fields whose writes change the screen (spec P3-20).
 * `matters.stage` is outside it (advanceStage writes only `stage`); of the `firms` doc only
 * `featureFlags` is read (`featureFlags.L17_2_ENABLED`). The recorder sees transaction, batch and
 * document-reference writes only; `functions/test/p2.registry-recorder-attribution.emu.test.ts` fails
 * if functions/src starts using a BulkWriter or recursiveDelete, which it cannot see. Deep-frozen.
 */
export const REGISTRY_SCOPE: Readonly<Record<string, RegistryFieldScope>> = Object.freeze({
  clients: Object.freeze({ all: true as const }),
  matter_parties: Object.freeze({ all: true as const }),
  entity_links: Object.freeze({ all: true as const }),
  transliteration_map: Object.freeze({ all: true as const }),
  matters: Object.freeze({ except: Object.freeze(["stage"]) }),
  firms: Object.freeze({ only: Object.freeze(["featureFlags"]) }),
})

export const registryVersionRef = (firmId: string) => adminDb().collection("counters").doc(`${firmId}_registry`)

/**
 * The screen's own projection (F37): the firm's packed name index (`conflict/nameIndex.ts`), whose chunks
 * `loadScreeningRegistry` reads and whose state lives on this counter doc. A write to it changes what a
 * screen sees, so it is a registry write like the others: the recorder requires a bump in its transaction.
 */
export const PROJECTION_SCOPE: Readonly<Record<string, RegistryFieldScope>> = Object.freeze({
  conflict_name_index: Object.freeze({ all: true as const }),
})

/**
 * The name index state kept on the counter doc (F37, `nameIndex`): `schema` (null until the firm is born fresh
 * or reconciled), `version` (equal to the registry version while the index is complete; null when absent) and
 * the open chunk (`chunk`, with `bytes` counted into it). `valid` is false when a field is present but malformed.
 */
export type NameIndexState = { schema: number | null; version: number | null; chunk: number; bytes: number; valid: boolean }

/** The counter doc as one consistent read: whether it exists, the registry version and the name index state. */
export type RegistryState = { exists: boolean; version: number; nameIndex: NameIndexState }

const versionOf = (data: DocumentData | undefined): number => (typeof data?.version === "number" ? data.version : 0)

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0

const ABSENT_INDEX: NameIndexState = { schema: null, version: null, chunk: 0, bytes: 0, valid: true }

function nameIndexOf(raw: unknown): NameIndexState {
  if (raw === undefined) return ABSENT_INDEX
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...ABSENT_INDEX, valid: false }
  const r = raw as Record<string, unknown>
  const schema = r.schema ?? null
  const version = r.version ?? null
  const chunk = r.chunk ?? 0
  const bytes = r.bytes ?? 0
  if ((schema !== null && !isCount(schema)) || (version !== null && !isCount(version)) || !isCount(chunk) || !isCount(bytes)) {
    return { ...ABSENT_INDEX, valid: false }
  }
  return { schema: schema as number | null, version: version as number | null, chunk: chunk as number, bytes: bytes as number, valid: true }
}

function stateOf(exists: boolean, data: DocumentData | undefined): RegistryState {
  return { exists, version: versionOf(data), nameIndex: nameIndexOf(data?.nameIndex) }
}

/** The current version (0 before the first registry write), read outside any transaction. */
export async function readRegistryVersion(firmId: string): Promise<number> {
  return versionOf((await registryVersionRef(firmId).get()).data())
}

/** The version read in `tx` (so a concurrent bump either commits first or after `tx`). A read: call it before `tx`'s writes. */
export async function readRegistryVersionTx(tx: Transaction, firmId: string): Promise<number> {
  return versionOf((await tx.get(registryVersionRef(firmId))).data())
}

/** The registry version and the name index state in one read, outside any transaction. */
export async function readRegistryState(firmId: string): Promise<RegistryState> {
  const snap = await registryVersionRef(firmId).get()
  return stateOf(snap.exists, snap.data())
}

/** The registry version and the name index state read in `tx`. A read: call it before `tx`'s writes. */
export async function readRegistryStateTx(tx: Transaction, firmId: string): Promise<RegistryState> {
  const snap = await tx.get(registryVersionRef(firmId))
  return stateOf(snap.exists, snap.data())
}

/** Name index fields a writer sets with its bump (absolute values; `version` replaces the mirror increment). */
export type NameIndexPatch = { schema?: number; version?: number; chunk?: number; bytes?: number }

/**
 * Stages the version bump in the caller's transaction (no read). The name index mirror (`nameIndex.version`)
 * moves with it (F37), so the index reads current exactly while every registry write goes through here;
 * `nameIndex` sets other index fields in the same write (`conflict/nameIndex.ts` stageRegistryWrite).
 */
export function bumpRegistryVersion(tx: Transaction, firmId: string, nameIndex: NameIndexPatch = {}): void {
  tx.set(
    registryVersionRef(firmId),
    { firmId, kind: "registry", version: FieldValue.increment(1), classification: "internal", nameIndex: { version: FieldValue.increment(1), ...nameIndex } },
    { merge: true }
  )
}
