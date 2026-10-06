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
 * cross-tenant test (Gate G-2). onboardFirm reads `g2Passed` in its
 * transaction before creating any firm after the first.
 *
 * A pass covers the code it was run on. Re-run `npm run gate:g2` and record a
 * new pass whenever the tenant surface changes shape, in particular when the
 * D2-1 WhatsApp webhook (phone-number to user binding) lands, when D5-1 web
 * research reads land, and when the Postgres migration moves matters and
 * documents behind RLS (L18 §10: "after the Postgres migration the same suite
 * runs against RLS"). The stored commitSha and counts show what was covered.
 */

export const GATES = ["G-2"] as const
export type Gate = (typeof GATES)[number]

const MAX_SUMMARY = 2000
const MAX_URL = 500
const SHA_RE = /^[0-9a-f]{7,40}$/
const EVIDENCE_KEYS: ReadonlySet<string> = new Set(["summary", "commitSha", "runUrl", "counts"])
const COUNT_KEYS = ["tested", "notBuilt", "outOfScope", "global", "allowed"] as const

/** The gate run's coverage counts, as `npm run gate:g2` prints them. */
export type GateCounts = Record<(typeof COUNT_KEYS)[number], number>
/** What a pass records: the run (commit and CI run URL), its counts, and a summary. */
export type GateEvidence = { summary: string; commitSha: string; runUrl: string; counts: GateCounts }

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

const isRecord = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * `{ summary, commitSha, runUrl, counts: { tested, notBuilt, outOfScope, global, allowed } }`
 * and nothing else (400 invalid_evidence otherwise). The counts must be those of a
 * green run: at least one path tested and none allowed.
 */
function parseEvidence(value: unknown): GateEvidence {
  const bad = () => new HttpError(400, "invalid_evidence")
  if (!isRecord(value)) throw bad()
  if (Object.keys(value).some((k) => !EVIDENCE_KEYS.has(k))) throw bad()
  const summary = typeof value.summary === "string" ? value.summary.trim() : ""
  if (summary === "" || summary.length > MAX_SUMMARY) throw bad()
  const { commitSha, runUrl, counts } = value
  if (typeof commitSha !== "string" || !SHA_RE.test(commitSha)) throw bad()
  if (typeof runUrl !== "string" || runUrl.length > MAX_URL || !isHttpsUrl(runUrl)) throw bad()
  if (!isRecord(counts) || Object.keys(counts).length !== COUNT_KEYS.length) throw bad()
  const parsed = {} as GateCounts
  for (const k of COUNT_KEYS) {
    const n = counts[k]
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw bad()
    parsed[k] = n
  }
  if (parsed.tested === 0 || parsed.allowed !== 0) throw bad()
  return { summary, commitSha, runUrl, counts: parsed }
}

/** True once a platform admin has recorded a G-2 pass (a server-written Timestamp; anything else is not a pass). */
export async function g2Passed(tx: Transaction): Promise<boolean> {
  return (await tx.get(gatesRef())).data()?.g2PassedAt instanceof Timestamp
}

/**
 * recordGatePass({ gate: "G-2", evidence: { summary, commitSha, runUrl, counts } })
 * → { gate, passId }. The evidence is the line `npm run gate:g2` prints. Platform admin
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
