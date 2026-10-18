import type { DocumentReference } from "firebase-admin/firestore"
import { adminDb } from "../admin"

/**
 * P1 configuration and totals in Firestore (spec P3-63..P3-66). All of these are server-only in
 * `firestore.rules`: the firm's `ai_config/{firmId}`, the platform's `platform/p1`, the month total
 * `ai_usage_months/{firmId}_{monthKey}`, the alerts `ai_budget_alerts/{firmId}_{monthKey}_{70|90}`, the
 * reservations `ai_reservations/{usageLogId}` (audit F07, F08), the learned request overhead `platform/p1Overhead`
 * and the reconciler's sweep cursor `platform/p1ReconcileCursor`.
 */

/** A kill switch, firm or platform (P3-66). A request replaces the whole state. */
export type KillSwitch = { disableAll: boolean; disabledModels: string[]; reason: string; setBy: string; setAt: unknown }

/**
 * `ai_config/{firmId}` (P3-64, P3-66). The budget is integer micro-USD per PKT calendar month. `maxConcurrentCalls`
 * bounds the firm's live reservations (F07); it is server-set only (no route writes it) and defaults to 4.
 */
export type FirmAiConfig = { monthlyBudgetMicroUsd?: number; pkrPerUsd?: number; killSwitch?: KillSwitch; maxConcurrentCalls?: number }

/**
 * Live reservations a firm may hold at once when its config sets no valid `maxConcurrentCalls` (F07). Four
 * concurrent Opus calls of a 4,096-token ceiling hold about 0.33 USD in flight; `committeeBrain` also limits each
 * user to 10 calls a minute, so four parallel calls per firm serves a small chamber without unbounded in-flight spend.
 */
export const DEFAULT_MAX_CONCURRENT_CALLS = 4
/** The largest `maxConcurrentCalls` honoured; a larger or malformed value falls back to the default. */
export const MAX_CONCURRENT_CALLS_CAP = 64

export function reservationRef(usageLogId: string): DocumentReference {
  return adminDb().collection("ai_reservations").doc(usageLogId)
}

/** The alert thresholds, in percent of the month's budget; fixed, not configurable (P3-65). */
export const THRESHOLDS = [70, 90] as const

export function firmConfigRef(firmId: string): DocumentReference {
  return adminDb().collection("ai_config").doc(firmId)
}

/** The platform's P1 doc, which holds the platform kill switch (P3-66). */
export function platformConfigRef(): DocumentReference {
  return adminDb().collection("platform").doc("p1")
}

/**
 * The request overhead learned from breaches, per model (audit F07, Copilot finding on PR #40), server-only like the
 * rest of `platform/*`: `{ models: { [modelOverheadKey(model)]: { model, inputTokens, usageLogId, learnedAt } } }`.
 * `inputTokens` is the largest overhead a settlement has seen for the model: the input tokens the provider billed
 * less the body's ceiling. Only ever raised, in the transaction of the settlement that saw it.
 */
export function overheadRef(): DocumentReference {
  return adminDb().collection("platform").doc("p1Overhead")
}

/** A model id as one map key: every character outside letters, digits, `_` and `-` becomes `_` ("a/b-1.5" is "a_b-1_5"). */
export function modelOverheadKey(model: string): string {
  return model.replace(/[^A-Za-z0-9_-]/g, "_")
}

/**
 * The overhead learned for `model` from the `platform/p1Overhead` doc; 0 when there is none or it is malformed. Two
 * model ids that share a key share the larger figure, which only reserves more.
 */
export function learnedOverheadOf(doc: unknown, model: string): number {
  const models = (doc as { models?: unknown } | null | undefined)?.models
  if (!models || typeof models !== "object") return 0
  const key = modelOverheadKey(model)
  const entry = Object.hasOwn(models, key) ? (models as Record<string, unknown>)[key] : undefined
  const n = (entry as { inputTokens?: unknown } | null | undefined)?.inputTokens
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0
}

export function monthRef(firmId: string, monthKey: string): DocumentReference {
  return adminDb().collection("ai_usage_months").doc(`${firmId}_${monthKey}`)
}

/** Deterministic, so each threshold fires once per firm per month (P3-65). */
export function alertRef(firmId: string, monthKey: string, threshold: (typeof THRESHOLDS)[number]): DocumentReference {
  return adminDb().collection("ai_budget_alerts").doc(`${firmId}_${monthKey}_${threshold}`)
}

/** The budget in micro-USD when it is a positive integer; anything else is "not set" (P3-64, fail closed). */
export function budgetOf(cfg: unknown): number | null {
  const b = (cfg as { monthlyBudgetMicroUsd?: unknown } | null | undefined)?.monthlyBudgetMicroUsd
  return typeof b === "number" && Number.isSafeInteger(b) && b > 0 ? b : null
}

/** The PKR per USD rate when it is a positive finite number; there is no default rate (P3-64). */
export function pkrRateOf(cfg: unknown): number | null {
  const r = (cfg as { pkrPerUsd?: unknown } | null | undefined)?.pkrPerUsd
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : null
}

/** The month's spend in micro-USD from a month total doc; 0 when there is none yet. */
export function spentOf(month: unknown): number {
  const s = (month as { spentMicroUsd?: unknown } | null | undefined)?.spentMicroUsd
  return typeof s === "number" && Number.isFinite(s) ? s : 0
}

/** The worst cases the month's live reservations hold, in micro-USD (F07); 0 when there are none, never negative. */
export function reservedOf(month: unknown): number {
  const r = (month as { reservedMicroUsd?: unknown } | null | undefined)?.reservedMicroUsd
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 0
}

/** The firm's bound on live reservations: `maxConcurrentCalls` when an integer from 1 to the cap, else the default (F07). */
export function maxConcurrentOf(cfg: unknown): number {
  const n = (cfg as { maxConcurrentCalls?: unknown } | null | undefined)?.maxConcurrentCalls
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= MAX_CONCURRENT_CALLS_CAP ? n : DEFAULT_MAX_CONCURRENT_CALLS
}

/**
 * True when a stored kill switch blocks `model`: `disableAll` exactly true blocks every model; otherwise the
 * model blocks when it is in `disabledModels` (exact string match). Anything malformed blocks nothing.
 */
export function killSwitchBlocks(killSwitch: unknown, model: string): boolean {
  if (!killSwitch || typeof killSwitch !== "object") return false
  const ks = killSwitch as { disableAll?: unknown; disabledModels?: unknown }
  if (ks.disableAll === true) return true
  return Array.isArray(ks.disabledModels) && ks.disabledModels.some((m) => m === model)
}
