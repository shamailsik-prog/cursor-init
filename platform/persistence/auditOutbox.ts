/**
 * Audit F11: the audit outbox of one Next request.
 *
 * withSession opens it around the handler. While the handler runs, every effect write it makes through the four
 * firestoreDbModular helpers asks it for an entry (`currentSession`, installed below as `installWriteFence` is installed
 * by idempotency.ts) and commits that entry in the same transaction or batch as the effect: the request's audit rows
 * collected so far and not yet staged (normalised in place, so the flush later persists the same ids), the paths the write
 * touched, and who, which firm, which route and action, which F10 operation.
 *
 * After a successful end-of-request flush every row of the request is in the audit log, and `release` deletes the
 * request's entries. If the flush fails, or the process dies anywhere after a commit, the entries stay and the reconciler
 * (functions/src/p5/auditOutbox.ts) publishes them once the grace has passed. Nothing depends on the process any more.
 * Spec: docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { currentRequestAuditRows } from "@/platform/audit/requestAudit"
import {
  AUDIT_OUTBOX_COLLECTION,
  AUDIT_OUTBOX_MAX_ROW_BYTES,
  AUDIT_OUTBOX_MAX_ROWS,
  isEffectPath,
  jsonCopy,
  type AuditOutboxEntry,
} from "@/platform/persistence/auditOutboxContract"
import { normalizeAuditEntryInPlace } from "@/platform/persistence/auditWriteThrough"
import { deleteDoc, doc, installAuditOutbox, type OutboxSession } from "@/platform/persistence/firestoreDbModular"
import type { AuditEntry, SpineStore } from "@/platform/spine/store"

/** Who and what a request is, as its outbox entries record it. */
export type RequestOutboxMeta = {
  /** The session firm; null for a request with no session (public routes, an unknown insecure-dev identity). */
  firmId: string | null
  actorId: string | null
  /** `METHOD /path`. */
  route: string
  /** The body's top-level `action`, when it is a short identifier. */
  requestAction: string | null
}

type State = {
  readonly meta: RequestOutboxMeta
  readonly requestId: string
  seq: number
  /** The request's audit rows (the live collector array of platform/audit/requestAudit.ts). */
  rows: readonly AuditEntry[]
  /** Rows already in a committed entry. */
  readonly staged: WeakSet<AuditEntry>
  /** Entries committed by this request: where, and their ids. */
  readonly committed: Array<{ db: unknown; id: string }>
  store: SpineStore | null
}

const storage = new AsyncLocalStorage<State>()

/** The request's rows not yet in a committed entry, normalised in place, within the entry's caps (ruling 14). */
function stageableRows(state: State): { objects: AuditEntry[]; copies: Record<string, unknown>[] } {
  const objects: AuditEntry[] = []
  const copies: Record<string, unknown>[] = []
  let bytes = 0
  for (const row of state.rows) {
    if (state.staged.has(row)) continue
    if (objects.length >= AUDIT_OUTBOX_MAX_ROWS || state.store === null) break
    try {
      normalizeAuditEntryInPlace(state.store, row)
    } catch {
      // No resolvable firm: never persistable; the flush dead-letters it, as before.
      continue
    }
    const copy = jsonCopy(row) as unknown as Record<string, unknown>
    const size = JSON.stringify(copy).length
    if (bytes + size > AUDIT_OUTBOX_MAX_ROW_BYTES) break
    bytes += size
    objects.push(row)
    copies.push(copy)
  }
  return { objects, copies }
}

/** The outbox session of one write of the current request (null outside a request). */
function currentSession(): OutboxSession | null {
  const state = storage.getStore()
  if (state === undefined) return null
  const seq = state.seq++
  const id = `${state.requestId}_${seq}`
  let pending: { db: unknown; rows: AuditEntry[] } | null = null
  return {
    entry(db, paths, operationId) {
      const effectPaths = [...new Set(paths.filter(isEffectPath))]
      if (effectPaths.length === 0) {
        pending = null
        return null
      }
      const rows = stageableRows(state)
      pending = { db, rows: rows.objects }
      const data: AuditOutboxEntry = {
        v: 1,
        surface: "next",
        firmId: state.meta.firmId,
        actorId: state.meta.actorId,
        route: state.meta.route,
        requestAction: state.meta.requestAction,
        operationId: operationId ?? null,
        requestId: state.requestId,
        seq,
        effectPaths,
        rows: rows.copies,
        stagedAt: new Date(),
        attempts: 0,
      }
      return { id, data: data as unknown as Record<string, unknown> }
    },
    committed() {
      if (pending === null) return
      for (const row of pending.rows) state.staged.add(row)
      state.committed.push({ db: pending.db, id })
      pending = null
    },
  }
}

installAuditOutbox(currentSession)

/** The audit outbox of one request (spec §2.3). */
export class RequestOutbox {
  private readonly state: State

  constructor(meta: RequestOutboxMeta) {
    this.state = {
      meta,
      requestId: randomUUID(),
      seq: 0,
      rows: [],
      staged: new WeakSet(),
      committed: [],
      store: null,
    }
  }

  /** Ids of the entries this request committed and has not released. */
  get entryIds(): readonly string[] {
    return this.state.committed.map((entry) => entry.id)
  }

  /** Runs the handler with this outbox open. Call inside the request's audit collector (runWithRequestAudit). */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const { getRuntimeStore } = await import("@/platform/spine/runtimeStore")
    this.state.store = getRuntimeStore()
    this.state.rows = currentRequestAuditRows()
    return storage.run(this.state, fn)
  }

  /**
   * Every row of the request is in the audit log (the flush succeeded): delete the request's entries. A delete that
   * fails is logged and left; the reconciler then finds the rows present and records the request (spec §5).
   */
  async release(): Promise<void> {
    const entries = this.state.committed.splice(0)
    if (entries.length === 0) return
    const results = await Promise.allSettled(entries.map(({ db, id }) => deleteDoc(doc(db as never, AUDIT_OUTBOX_COLLECTION, id))))
    const failed = results.filter((r) => r.status === "rejected").length
    if (failed > 0) {
      console.error(`[audit] could not release ${failed} audit outbox entr${failed === 1 ? "y" : "ies"} of ${this.state.meta.route}; the reconciler will publish them`)
    }
  }
}

export function openRequestOutbox(meta: RequestOutboxMeta): RequestOutbox {
  return new RequestOutbox(meta)
}
