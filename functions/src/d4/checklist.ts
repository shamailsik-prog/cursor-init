/**
 * L5.4 per-document-type filing readiness. Pure functions: no store, no route.
 *
 * `getChecklistForType` reads the verified doctype row and returns that type's
 * filing items, or `{ known: false }` when the id is empty, unknown, or the row
 * names no filing accompaniment. `getReadiness` applies an explicit `produced`
 * input. `blockIfIncomplete` returns a refusal when a mandatory item is open.
 * Nothing here is called from `gateOps.ts`; wave 2 wires the refusal with L4.1.
 *
 * The env flag is for that later wiring. Unset means off. These functions do
 * not read it, so a unit test can judge the checklist without turning a route on.
 *
 * Docket auto-tick is the L5.5 seam (open PR 248 owns the docket builder) and
 * stays false. A docket id in `produced` does not tick the index.
 */
import { getDocumentType } from "./doctypes"
import { itemsForDocumentType, type ChecklistItem } from "./checklistProfiles"

export const D4_CHECKLIST_FLAG = "D4_CHECKLIST"

/** Unset, blank, or any value other than `true` (after trim, case-insensitive) is off. */
export function isD4ChecklistEnabled(): boolean {
  return process.env[`SIKANDER_FLAG_${D4_CHECKLIST_FLAG}`]?.trim().toLowerCase() === "true"
}

/** L5.5 has not been wired. Keep this false until that docket builder ticks the index. */
export const DOCKET_AUTO_TICK_WIRED = false

export type { ChecklistCompletion, ChecklistItem, ChecklistItemKind } from "./checklistProfiles"

export type ManualTick = {
  itemId: string
  by: string
  at: string
  /** Closes a conditional item only. Ignored on an item that is not conditional. */
  notApplicable?: boolean
}

/** What has already been produced. There is no fee input: the fee tick is manual. An annexure id ticks only the annexure item with that same id. */
export type Produced = {
  affidavitId?: string | null
  docketId?: string | null
  annexureIds?: readonly string[] | null
  manualTicks?: readonly ManualTick[] | null
}

export type UnknownChecklist = { known: false }

export type KnownChecklist = {
  known: true
  documentTypeId: string
  items: ChecklistItem[]
}

export type ChecklistResult = KnownChecklist | UnknownChecklist

export type RefusalReason = "empty_document_type" | "unknown_type" | "no_filing_profile"

export type ReadinessProgress = {
  done: number
  total: number
  mandatoryDone: number
  mandatoryTotal: number
}

export type ReadinessItem = ChecklistItem & {
  done: boolean
  completedBy: "manual" | "affidavit" | "annexures" | "docket" | "not_applicable" | null
  actor: { by: string; at: string } | null
}

export type ReadinessRefusal = {
  known: false
  reason: RefusalReason
  readyToFile: false
  missingMandatory: []
  progress: { done: 0; total: 0; mandatoryDone: 0; mandatoryTotal: 0 }
  items: []
  docketAutoTickWired: boolean
}

export type ReadinessKnown = {
  known: true
  documentTypeId: string
  readyToFile: boolean
  missingMandatory: string[]
  progress: ReadinessProgress
  items: ReadinessItem[]
  docketAutoTickWired: boolean
}

export type Readiness = ReadinessKnown | ReadinessRefusal

export type BlockResult = {
  blocked: boolean
  reason: string | null
  missingMandatory: string[]
}

type Actor = { by: string; at: string; notApplicable: boolean }

/** A calendar date, or a time with seconds and a timezone, that parses to that same calendar day. */
function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return false
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return false
  if (value.length === 10) return parsed.toISOString().slice(0, 10) === value
  return true
}

function classified(documentTypeId: unknown):
  | { kind: "empty" }
  | { kind: "unknown" }
  | { kind: "no_profile" }
  | { kind: "ready"; id: string; items: ChecklistItem[] } {
  if (typeof documentTypeId !== "string" || documentTypeId.trim() === "") return { kind: "empty" }
  const type = getDocumentType(documentTypeId)
  if (type === null) return { kind: "unknown" }
  const items = itemsForDocumentType(type).map((item) =>
    item.kind === "index_docket" ? { ...item, autoTickWired: DOCKET_AUTO_TICK_WIRED } : item
  )
  if (items.length === 0) return { kind: "no_profile" }
  return { kind: "ready", id: documentTypeId, items }
}

function refusalReason(kind: "empty" | "unknown" | "no_profile"): RefusalReason {
  if (kind === "empty") return "empty_document_type"
  if (kind === "unknown") return "unknown_type"
  return "no_filing_profile"
}

function refuseReadiness(reason: RefusalReason): ReadinessRefusal {
  return {
    known: false,
    reason,
    readyToFile: false,
    missingMandatory: [],
    progress: { done: 0, total: 0, mandatoryDone: 0, mandatoryTotal: 0 },
    items: [],
    docketAutoTickWired: DOCKET_AUTO_TICK_WIRED,
  }
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

function annexureIdSet(value: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(value)) return ids
  for (const entry of value) {
    const id = text(entry)
    if (id !== null) ids.add(id)
  }
  return ids
}

function ticksOf(produced: Produced): Map<string, Actor> {
  const ticks = new Map<string, Actor>()
  if (!Array.isArray(produced.manualTicks)) return ticks
  for (const tick of produced.manualTicks) {
    if (tick === null || typeof tick !== "object") continue
    const itemId = text(tick.itemId)
    const by = text(tick.by)
    const at = text(tick.at)
    if (itemId === null || by === null || at === null || !isRealIsoDate(at)) continue
    ticks.set(itemId, { by, at, notApplicable: tick.notApplicable === true })
  }
  return ticks
}

function normalizeProduced(produced: Produced | null | undefined): Produced {
  if (produced === null || produced === undefined || typeof produced !== "object") return {}
  return produced
}

function settle(item: ChecklistItem, produced: Produced, ticks: Map<string, Actor>, annexureIds: Set<string>): ReadinessItem {
  const manual = ticks.get(item.id) ?? null
  if (item.completion === "affidavit" && text(produced.affidavitId) !== null) {
    return { ...item, done: true, completedBy: "affidavit", actor: null }
  }
  if (item.completion === "annexures" && annexureIds.has(item.id)) {
    return { ...item, done: true, completedBy: "annexures", actor: null }
  }
  if (item.completion === "docket" && DOCKET_AUTO_TICK_WIRED && text(produced.docketId) !== null) {
    return { ...item, done: true, completedBy: "docket", actor: null }
  }
  if (manual !== null && manual.notApplicable && item.conditional) {
    return { ...item, done: true, completedBy: "not_applicable", actor: { by: manual.by, at: manual.at } }
  }
  if (manual !== null && !manual.notApplicable) return { ...item, done: true, completedBy: "manual", actor: { by: manual.by, at: manual.at } }
  return { ...item, done: false, completedBy: null, actor: null }
}

/** The checklist for one document type, or `{ known: false }`. */
export function getChecklistForType(documentTypeId: string): ChecklistResult {
  const found = classified(documentTypeId)
  if (found.kind !== "ready") return { known: false }
  return { known: true, documentTypeId: found.id, items: found.items }
}

/** Progress, the missing mandatory ids, and whether the bundle may be filed. */
export function getReadiness(documentTypeId: string, produced?: Produced | null): Readiness {
  const found = classified(documentTypeId)
  if (found.kind !== "ready") return refuseReadiness(refusalReason(found.kind))
  const input = normalizeProduced(produced)
  const ticks = ticksOf(input)
  const annexureIds = annexureIdSet(input.annexureIds)
  const items = found.items.map((item) => settle(item, input, ticks, annexureIds))
  const mandatory = items.filter((item) => item.mandatory)
  const missingMandatory = mandatory.filter((item) => !item.done).map((item) => item.id)
  const done = items.filter((item) => item.done).length
  const mandatoryDone = mandatory.filter((item) => item.done).length
  return {
    known: true,
    documentTypeId: found.id,
    readyToFile: missingMandatory.length === 0,
    missingMandatory,
    progress: {
      done,
      total: items.length,
      mandatoryDone,
      mandatoryTotal: mandatory.length,
    },
    items,
    docketAutoTickWired: DOCKET_AUTO_TICK_WIRED,
  }
}

/**
 * Refusal when the type is not a filing profile or a mandatory item is still open.
 * Exported for wave 2. Not called from the gate.
 */
export function blockIfIncomplete(documentTypeId: string, produced?: Produced | null): BlockResult {
  const readiness = getReadiness(documentTypeId, produced)
  if (!readiness.known) {
    return { blocked: true, reason: readiness.reason, missingMandatory: [] }
  }
  if (readiness.missingMandatory.length === 0) {
    return { blocked: false, reason: null, missingMandatory: [] }
  }
  return {
    blocked: true,
    reason: `filing_incomplete: ${readiness.missingMandatory.join(", ")}`,
    missingMandatory: readiness.missingMandatory,
  }
}
