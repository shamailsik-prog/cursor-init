/**
 * Audit F42 (FA-F42-R1-001, spec R21): the matters an idempotent operation touched, shared by both API stacks.
 *
 * A stored answer used to be replayed for its key before any authority or tombstone check, so a same-key retry after the
 * matter's deletion returned the deleted matter's earlier answer (its title included). Now an operation records the
 * matters it touched, on its idempotency record, and a replay reads their tombstones first and refuses `matter_deleted`
 * as a fresh call does.
 *
 * Two sources, unioned: every matter a permission check of the request named (`recordOperationMatter`, called by the
 * Functions `evaluate` and the Next `checkPermission`), recorded into every enclosing recording scope (a Next core
 * served inside the Functions F02 frame records into both operations); and every `matterId` / `linkedMatterId` string
 * in the stored body (`matterIdsInBody`), which covers an operation that creates its matter and a record stored before
 * this change. Pure but for the AsyncLocalStorage: no Firestore, Next.js or firebase imports.
 */
import { AsyncLocalStorage } from "node:async_hooks"

type Scope = { matters: Set<string>; parent: Scope | null }

const storage = new AsyncLocalStorage<Scope>()

/** Runs `fn` with `matters` as a recording scope, inside any scope already open (each records into both). */
export function runRecordingMatters<T>(matters: Set<string>, fn: () => T): T {
  return storage.run({ matters, parent: storage.getStore() ?? null }, fn)
}

/** Notes that the current operation touched `matterId` (a no-op outside a recording scope). */
export function recordOperationMatter(matterId: unknown): void {
  if (typeof matterId !== "string" || matterId === "" || matterId.includes("/")) return
  for (let s = storage.getStore() ?? null; s !== null; s = s.parent) s.matters.add(matterId)
}

/** At most this many matter ids are kept on a record; more marks it truncated, and it is never replayed (fail closed). */
export const MAX_RECORDED_MATTERS = 50
const MAX_DEPTH = 8
const MATTER_KEYS: ReadonlySet<string> = new Set(["matterId", "linkedMatterId"])

/** Every string `matterId` / `linkedMatterId` in `body`, to `MAX_DEPTH` levels and one past `MAX_RECORDED_MATTERS` ids. */
export function matterIdsInBody(body: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number): void => {
    if (out.size > MAX_RECORDED_MATTERS || depth > MAX_DEPTH || v === null || typeof v !== "object") return
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
      if (MATTER_KEYS.has(k) && typeof value === "string" && value !== "" && !value.includes("/")) out.add(value)
      else walk(value, depth + 1)
    }
  }
  walk(body, 0)
  return [...out]
}

/** The fields an idempotency record stores for its answer: the matter ids (sorted) and whether they were cut short. */
export function recordedMatterFields(recorded: Iterable<string>, body: unknown): { matterIds: string[]; matterIdsTruncated: boolean } {
  const all = [...new Set([...recorded, ...matterIdsInBody(body)])].sort()
  return { matterIds: all.slice(0, MAX_RECORDED_MATTERS), matterIdsTruncated: all.length > MAX_RECORDED_MATTERS }
}

/** The matter ids a stored record's replay must check: its stored list and its body's, and whether it was cut short. */
export function matterIdsToCheck(record: { matterIds?: unknown; matterIdsTruncated?: unknown }, body: unknown): { ids: string[]; truncated: boolean } {
  const stored = Array.isArray(record.matterIds) ? record.matterIds.filter((m): m is string => typeof m === "string" && m !== "" && !m.includes("/")) : []
  const ids = [...new Set([...stored, ...matterIdsInBody(body)])]
  return { ids: ids.slice(0, MAX_RECORDED_MATTERS + 1), truncated: record.matterIdsTruncated === true || ids.length > MAX_RECORDED_MATTERS }
}
