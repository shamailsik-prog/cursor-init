import { FieldValue, type DocumentData, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"

/**
 * The firm's conflict-registry version (Bugbot PR #8; spec P2-6, P2-30). `openMatter` re-screens a
 * check against `loadRegistry` before its transaction; this counter makes that screen consistent with
 * the transaction. Every write that changes what `loadRegistry` reads (and the screen consumes) bumps
 * it in that write's own transaction:
 *
 * - registerClient: `clients` (+ `entities`) and candidate `entity_links`;
 * - openMatter: `matters` and `matter_parties`;
 * - closeMatter: `matters.status` and `matter_parties.matterStatus`;
 * - confirmMerge, disputeLink, rejectLink: `entity_links` state.
 *
 * Not bumped: advanceStage (writes `matters.stage`, which the screen never reads); the `firms` doc
 * writers (prefixes, MFA policy, onboarding: fields the screen never reads; `featureFlags.L17_2_ENABLED`
 * has no writer in functions/src); `transliteration_map` (no writer in functions/src).
 *
 * The doc lives with the other per-firm counters, `counters/{firmId}_registry` (server-only under
 * firestore.rules: `counters` denies every client read and write). The bump is a blind
 * `FieldValue.increment` write, so it needs no read and may sit anywhere among a transaction's writes.
 */

export const registryVersionRef = (firmId: string) => adminDb().collection("counters").doc(`${firmId}_registry`)

const versionOf = (data: DocumentData | undefined): number => (typeof data?.version === "number" ? data.version : 0)

/** The current version (0 before the first registry write), read outside any transaction. */
export async function readRegistryVersion(firmId: string): Promise<number> {
  return versionOf((await registryVersionRef(firmId).get()).data())
}

/** The version read in `tx` (so a concurrent bump either commits first or after `tx`). A read: call it before `tx`'s writes. */
export async function readRegistryVersionTx(tx: Transaction, firmId: string): Promise<number> {
  return versionOf((await tx.get(registryVersionRef(firmId))).data())
}

/** Stages the version bump in the caller's transaction (no read). */
export function bumpRegistryVersion(tx: Transaction, firmId: string): void {
  tx.set(registryVersionRef(firmId), { firmId, kind: "registry", version: FieldValue.increment(1), classification: "internal" }, { merge: true })
}
