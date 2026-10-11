import type { DocumentReference } from "firebase-admin/firestore"
import { adminDb } from "../admin"

/**
 * P1 configuration and totals in Firestore (spec P3-63..P3-66). All of these are server-only in
 * `firestore.rules`: the firm's `ai_config/{firmId}`, the platform's `platform/p1`, the month total
 * `ai_usage_months/{firmId}_{monthKey}` and the alerts `ai_budget_alerts/{firmId}_{monthKey}_{70|90}`.
 */

/** A kill switch, firm or platform (P3-66). A request replaces the whole state. */
export type KillSwitch = { disableAll: boolean; disabledModels: string[]; reason: string; setBy: string; setAt: unknown }

/** `ai_config/{firmId}` (P3-64, P3-66). The budget is integer micro-USD per PKT calendar month. */
export type FirmAiConfig = { monthlyBudgetMicroUsd?: number; pkrPerUsd?: number; killSwitch?: KillSwitch }

/** The alert thresholds, in percent of the month's budget; fixed, not configurable (P3-65). */
export const THRESHOLDS = [70, 90] as const

export function firmConfigRef(firmId: string): DocumentReference {
  return adminDb().collection("ai_config").doc(firmId)
}

/** The platform's P1 doc, which holds the platform kill switch (P3-66). */
export function platformConfigRef(): DocumentReference {
  return adminDb().collection("platform").doc("p1")
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
