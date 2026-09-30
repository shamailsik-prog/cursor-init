import { onCall } from "firebase-functions/v2/https"
import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { CALLABLE_OPTIONS } from "../health"
import { HttpError } from "../http/errors"
import { callableHandler, type Data, type FirmlessOperation } from "./common"

/**
 * Platform gates (L18 §10, R-5). `platform/gates` records which gates have
 * passed; it is written only here, by the Admin SDK (no rules match
 * `platform/*`, so clients are denied by default). `gate_passes/{id}` keeps
 * every recorded pass with its evidence (server-only as well).
 *
 * R-5: no second firm is onboarded until tenant isolation has passed a live
 * cross-tenant test (Gate G-2). onboardFirm reads `requireG2Passed` in its
 * transaction before creating any firm after the first.
 */

export const GATES = ["G-2"] as const
export type Gate = (typeof GATES)[number]

const MAX_SUMMARY = 2000
const MAX_URL = 500
const SHA_RE = /^[0-9a-f]{7,40}$/
const EVIDENCE_KEYS: ReadonlySet<string> = new Set(["summary", "commitSha", "runUrl"])

export type GateEvidence = { summary: string; commitSha?: string; runUrl?: string }

export const gatesRef = () => adminDb().collection("platform").doc("gates")

function parseGate(value: unknown): Gate {
  if (!GATES.includes(value as Gate)) throw new HttpError(400, "invalid_gate")
  return value as Gate
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

/** `{ summary, commitSha?, runUrl? }` and nothing else; 400 invalid_evidence otherwise. */
function parseEvidence(value: unknown): GateEvidence {
  const bad = () => new HttpError(400, "invalid_evidence")
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw bad()
  const raw = value as Data
  if (Object.keys(raw).some((k) => !EVIDENCE_KEYS.has(k))) throw bad()
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : ""
  if (summary === "" || summary.length > MAX_SUMMARY) throw bad()
  const evidence: GateEvidence = { summary }
  if (raw.commitSha !== undefined) {
    if (typeof raw.commitSha !== "string" || !SHA_RE.test(raw.commitSha)) throw bad()
    evidence.commitSha = raw.commitSha
  }
  if (raw.runUrl !== undefined) {
    if (typeof raw.runUrl !== "string" || raw.runUrl.length > MAX_URL || !isHttpsUrl(raw.runUrl)) throw bad()
    evidence.runUrl = raw.runUrl
  }
  return evidence
}

/** True once a platform admin has recorded a G-2 pass (a server-written Timestamp; anything else is not a pass). */
export async function g2Passed(tx: Transaction): Promise<boolean> {
  return (await tx.get(gatesRef())).data()?.g2PassedAt instanceof Timestamp
}

/**
 * recordGatePass({ gate: "G-2", evidence }) → { gate, passId }. Platform admin
 * only (`platformAdmin: true` in the caller's current custom claims; 403
 * platform_admin_only otherwise). In one transaction: the allow audit row,
 * `platform/gates` (g2PassedAt, g2PassedBy, g2Evidence, g2PassId) and an
 * append-only `gate_passes/{id}` row.
 */
export const recordGatePassOp: FirmlessOperation<{ gate: Gate; passId: string }> = {
  auth: "firmless",
  kind: "general",
  action: "platform.recordGatePass",
  target: "platform/gates",
  run: async ({ uid, claims }, data, audit) => {
    if (claims.platformAdmin !== true) throw new HttpError(403, "platform_admin_only")
    const gate = parseGate(data.gate)
    const evidence = parseEvidence(data.evidence)

    const db = adminDb()
    const passRef = db.collection("gate_passes").doc()
    audit.target = `gate_passes/${passRef.id}`
    await db.runTransaction(async (tx) => {
      await audit.stage(tx, "allow", "ok")
      const at = FieldValue.serverTimestamp()
      tx.create(passRef, { gate, evidence, recordedBy: uid, at })
      tx.set(gatesRef(), { g2PassedAt: at, g2PassedBy: uid, g2Evidence: evidence, g2PassId: passRef.id }, { merge: true })
    })
    audit.committed()
    return { gate, passId: passRef.id }
  },
}
export const recordGatePassHandler = callableHandler(recordGatePassOp)

export const recordGatePass = onCall(CALLABLE_OPTIONS, recordGatePassHandler)
