import { createHash } from "node:crypto"
import { Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { logFailure } from "../log"
import { firmConfigRef, killSwitchBlocks, platformConfigRef } from "./config"
import { appendAudit } from "../p5/audit"
import { isKnownClassification, rankOf } from "../p5/classification"
import { aggregateClassification } from "./ocrAggregate"
import {
  LOCAL_OCR_PROVIDER,
  measureOcrText,
  OcrTimeoutError,
  resolveOcrEngine,
  withOcrTimeout,
  type OcrEngine,
} from "./ocrEngine"

/**
 * P1 admission for one OCR extraction (erratum E-20, L17.3).
 *
 * Every extraction goes through here. The call carries the aggregate classification, which must be
 * at least every source label, and it is refused by the platform or firm kill switch before the
 * engine runs. The engine is a provider registered for the F18 control plane, or, outside
 * production, the deterministic local stub when none is configured. Production with no registered
 * provider records `provider_unsupported` and does not publish text. An operation id replays a
 * stored `ok` without calling the engine again.
 *
 * The operation row holds the text so a retry can publish it without a second extraction. It is
 * server-only (`p1_ocr_operations` in firestore.rules). The user-visible copy is `ocr_texts`.
 */

export const OCR_MODEL_ID = LOCAL_OCR_PROVIDER

const DEFAULT_TIMEOUT_MS = 20_000

export type OcrBlockReason = "kill_switch_platform" | "kill_switch_firm" | "provider_unsupported"

export type OcrFailureCode = "ocr_timeout" | "ocr_failed"

export type OcrCallRequest = {
  firmId: string
  actorId: string
  matterId: string | null
  jobId: string
  operationId: string
  legacyJobId: string
  documentId: string
  contentHash: string
  classification: Classification
  sources: readonly Classification[]
  bytes: Buffer
  mimeType: string
  timeoutMs?: number
  now?: () => number
}

export type OcrCallResult = {
  outcome: "ok" | "blocked" | "failed"
  blockReason: OcrBlockReason | null
  failureCode: OcrFailureCode | null
  text?: string
  confidence: number | null
  lowConfidence: boolean | null
  provider: string | null
  classification: Classification
  /** True when the stored text is a prefix of the extraction because it exceeded the UTF-8 cap. */
  truncated: boolean
  calls: number
  reused: boolean
}

export class OcrAdmissionError extends Error {
  readonly code: "classification_omitted" | "classification_below_source" | "operation_conflict"

  constructor(code: OcrAdmissionError["code"]) {
    super(code)
    this.name = "OcrAdmissionError"
    this.code = code
  }
}

/**
 * Test-only. `engine` replaces provider resolution (null is "unsupported"). `timeoutMs` replaces
 * the call budget. Both are ignored when NODE_ENV is production.
 */
export const ocrTestSeam: { engine?: OcrEngine | null; timeoutMs?: number } = {}

function seamAllows(): boolean {
  return process.env.NODE_ENV !== "production"
}

function engineForCall(): OcrEngine | null {
  if (seamAllows() && ocrTestSeam.engine !== undefined) return ocrTestSeam.engine
  return resolveOcrEngine()
}

function budgetMs(req: OcrCallRequest): number {
  if (seamAllows() && typeof ocrTestSeam.timeoutMs === "number") return ocrTestSeam.timeoutMs
  return req.timeoutMs ?? DEFAULT_TIMEOUT_MS
}

/** Stable id of the user-visible result for one document version. */
export function ocrTextId(firmId: string, documentId: string, contentHash: string): string {
  return "ocr" + createHash("sha256").update(`${firmId}\0${documentId}\0${contentHash}`).digest("hex").slice(0, 40)
}

function callsOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

export async function callP1Ocr(req: OcrCallRequest): Promise<OcrCallResult> {
  if (!isKnownClassification(req.classification)) throw new OcrAdmissionError("classification_omitted")
  for (const source of req.sources) {
    if (!isKnownClassification(source)) throw new OcrAdmissionError("classification_omitted")
  }
  if (req.sources.length === 0 || rankOf(req.classification) < rankOf(aggregateClassification([...req.sources]))) {
    throw new OcrAdmissionError("classification_below_source")
  }

  const now = req.now ?? Date.now
  const db = adminDb()
  const opRef = db.collection("p1_ocr_operations").doc(req.operationId)
  const existing = await opRef.get()
  if (existing.exists) {
    if (existing.get("firmId") !== req.firmId || existing.get("contentHash") !== req.contentHash) {
      throw new OcrAdmissionError("operation_conflict")
    }
    if (existing.get("outcome") === "ok") {
      const provider = existing.get("provider")
      return {
        outcome: "ok",
        blockReason: null,
        failureCode: null,
        text: typeof existing.get("text") === "string" ? existing.get("text") : "",
        confidence: typeof existing.get("confidence") === "number" ? existing.get("confidence") : null,
        lowConfidence: existing.get("lowConfidence") === true,
        provider: typeof provider === "string" ? provider : null,
        classification: req.classification,
        truncated: existing.get("truncated") === true,
        calls: callsOf(existing.get("calls")),
        reused: true,
      }
    }
  }

  const priorCalls = existing.exists ? callsOf(existing.get("calls")) : 0
  const [platformSnap, configSnap] = await db.getAll(platformConfigRef(), firmConfigRef(req.firmId))
  let block: OcrBlockReason | null = null
  if (killSwitchBlocks(platformSnap.get("killSwitch"), OCR_MODEL_ID)) block = "kill_switch_platform"
  else if (killSwitchBlocks(configSnap.get("killSwitch"), OCR_MODEL_ID)) block = "kill_switch_firm"

  const engine = block === null ? engineForCall() : null
  if (block === null && engine === null) block = "provider_unsupported"

  const at = Timestamp.fromMillis(Math.floor(now()))
  const base = {
    firmId: req.firmId,
    operationId: req.operationId,
    legacyJobId: req.legacyJobId,
    documentId: req.documentId,
    matterId: req.matterId,
    contentHash: req.contentHash,
    classification: req.classification,
    model: OCR_MODEL_ID,
    updatedAt: at,
    createdAt: existing.exists && existing.get("createdAt") ? existing.get("createdAt") : at,
  }

  const write = async (row: Record<string, unknown>): Promise<void> => {
    await opRef.set(row)
  }

  const audit = (action: string, decision: "allow" | "deny", reason: string): void => {
    void appendAudit({
      firmId: req.firmId,
      actorId: req.actorId,
      action,
      target: `ocr_texts/${ocrTextId(req.firmId, req.documentId, req.contentHash)}`,
      classification: req.classification,
      decision,
      reason,
    }).catch((err: unknown) => logFailure("ocr audit failed", err))
  }

  if (block !== null) {
    await write({
      ...base,
      outcome: "blocked",
      blockReason: block,
      failureCode: null,
      provider: null,
      confidence: null,
      lowConfidence: null,
      text: null,
      truncated: false,
      calls: priorCalls,
      reused: false,
    })
    audit("ocr.blocked", "deny", block)
    return {
      outcome: "blocked",
      blockReason: block,
      failureCode: null,
      confidence: null,
      lowConfidence: null,
      provider: null,
      classification: req.classification,
      truncated: false,
      calls: priorCalls,
      reused: false,
    }
  }

  try {
    const extraction = await withOcrTimeout(engine!.extract({ bytes: req.bytes, mimeType: req.mimeType }), budgetMs(req))
    const measured = measureOcrText(extraction.text)
    const text = measured.text
    const truncated = extraction.truncated === true || measured.truncated
    const admitReason = truncated ? "text_truncated" : "ok"
    if (truncated) {
      logger.info("ocr.text_truncated", {
        firmId: req.firmId,
        operationId: req.operationId,
        documentId: req.documentId,
        legacyJobId: req.legacyJobId,
      })
    }
    const calls = priorCalls + 1
    await write({
      ...base,
      outcome: "ok",
      blockReason: null,
      failureCode: null,
      provider: extraction.provider,
      confidence: extraction.confidence,
      lowConfidence: extraction.lowConfidence,
      text,
      truncated,
      calls,
      reused: false,
    })
    audit("ocr.admit", "allow", admitReason)
    return {
      outcome: "ok",
      blockReason: null,
      failureCode: null,
      text,
      confidence: extraction.confidence,
      lowConfidence: extraction.lowConfidence,
      provider: extraction.provider,
      classification: req.classification,
      truncated,
      calls,
      reused: false,
    }
  } catch (err) {
    const failureCode: OcrFailureCode = err instanceof OcrTimeoutError ? "ocr_timeout" : "ocr_failed"
    const calls = priorCalls + 1
    await write({
      ...base,
      outcome: "failed",
      blockReason: null,
      failureCode,
      provider: engine!.id,
      confidence: null,
      lowConfidence: null,
      text: null,
      truncated: false,
      calls,
      reused: false,
    })
    audit("ocr.fail", "deny", failureCode)
    return {
      outcome: "failed",
      blockReason: null,
      failureCode,
      confidence: null,
      lowConfidence: null,
      provider: null,
      classification: req.classification,
      truncated: false,
      calls,
      reused: false,
    }
  }
}
