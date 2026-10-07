import { describe, expect, it } from "vitest"
import {
  AuditAppendConflictError,
  createMemoryRepositories,
} from "@/platform/persistence/spineRepositories"
import { normalizeAuditEntryInPlace } from "@/platform/persistence/auditWriteThrough"
import { isAuditRowPersisted, markAuditRowPersisted } from "@/platform/audit/requestAudit"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { syncFirmAudit } from "@/platform/persistence/auditSync"
import { newStore, type AuditEntry, type SpineStore } from "@/platform/spine/store"

/** Persists rows as the request flush does: normalise in place, append, mark persisted. */
async function persistRows(store: SpineStore, repos: SpineRepositories, rows: readonly AuditEntry[]) {
  for (const row of rows) {
    if (isAuditRowPersisted(row)) continue
    normalizeAuditEntryInPlace(store, row)
    await repos.audit.append(row)
    markAuditRowPersisted(row)
  }
}

function auditRow(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "aud_fixed_1",
    firmId: "firmA",
    action: "matter_create",
    actorId: "partner_a",
    target: "mat_1",
    classification: "internal",
    at: 1,
    ...overrides,
  }
}

describe("audit log append-only (memory repository)", () => {
  it("rejects a second append that reuses an existing audit id and keeps the original row", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    await repos.audit.append(auditRow())

    const tampered = auditRow({ action: "matter_delete", target: "mat_other" })
    await expect(repos.audit.append(tampered)).rejects.toBeInstanceOf(AuditAppendConflictError)
    await expect(repos.audit.append(tampered)).rejects.toThrow(/aud_fixed_1/)

    const rows = await repos.audit.listByFirm("firmA")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe("matter_create")
    expect(rows[0]?.target).toBe("mat_1")
  })

  it("treats an identical re-append of an existing audit id as a no-op", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    await repos.audit.append(auditRow())
    await expect(repos.audit.append(auditRow())).resolves.toBeUndefined()
    await expect(repos.audit.append({ ...auditRow(), reason: undefined })).resolves.toBeUndefined()
    expect(await repos.audit.listByFirm("firmA")).toHaveLength(1)
  })

  it("still appends distinct ids and rows without an id", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    await repos.audit.append(auditRow({ id: "aud_a" }))
    await repos.audit.append(auditRow({ id: "aud_b" }))
    await repos.audit.append(auditRow({ id: undefined }))
    expect(await repos.audit.listByFirm("firmA")).toHaveLength(3)
  })

  it("write-through from the shared runtime store does not conflict with itself", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    const prior = store.audit.length
    store.audit.push({
      firmId: "firmA",
      action: "matter_create",
      actorId: "partner_a",
      target: "mat_1",
      classification: "internal",
    })
    store.audit.push({
      firmId: "firmA",
      action: "matter_confirm_engagement",
      actorId: "partner_a",
      target: "mat_1",
      classification: "internal",
    })
    await persistRows(store, repos, store.audit.slice(prior))
    const ids = store.audit.slice(prior).map((row) => row.id)
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(store.audit).toHaveLength(prior + 2)
  })

  function pushEntry(store: ReturnType<typeof newStore>, target: string) {
    store.audit.push({
      firmId: "firmA",
      action: "matter_update",
      actorId: "partner_a",
      target,
      classification: "internal",
    })
  }

  it("overlapping write-through ranges (concurrent requests) persist every row exactly once", async () => {
    // Durable backing store separate from the process-wide runtime store, as in Firestore mode.
    const runtime = newStore()
    const backing = newStore()
    const repos = createMemoryRepositories(backing)
    const priorA = runtime.audit.length
    pushEntry(runtime, "mat_a") // request A
    const priorB = runtime.audit.length
    pushEntry(runtime, "mat_b") // request B, interleaved before A persists
    // A persists its range, which also covers B's row; then B persists its own range.
    await persistRows(runtime, repos, runtime.audit.slice(priorA))
    await expect(persistRows(runtime, repos, runtime.audit.slice(priorB))).resolves.toBeUndefined()
    pushEntry(runtime, "mat_c")
    await expect(persistRows(runtime, repos, runtime.audit.slice(priorA))).resolves.toBeUndefined()
    const rows = await repos.audit.listByFirm("firmA")
    expect(rows.map((row) => row.target).sort()).toEqual(["mat_a", "mat_b", "mat_c"])
  })

  it("re-persisting rows after syncFirmAudit reorders the runtime store is idempotent", async () => {
    const runtime = newStore()
    const backing = newStore()
    const repos = createMemoryRepositories(backing)
    pushEntry(runtime, "mat_a")
    pushEntry(runtime, "mat_b")
    await persistRows(runtime, repos, runtime.audit.slice(0))
    await syncFirmAudit(runtime, repos, "firmA")
    await expect(persistRows(runtime, repos, runtime.audit.slice(0))).resolves.toBeUndefined()
    expect(await repos.audit.listByFirm("firmA")).toHaveLength(2)
  })

  it("still rejects a re-append whose content differs, even via write-through", async () => {
    const runtime = newStore()
    const backing = newStore()
    const repos = createMemoryRepositories(backing)
    pushEntry(runtime, "mat_a")
    await persistRows(runtime, repos, runtime.audit.slice(0))
    const persisted = runtime.audit[0]!
    runtime.audit[0] = { ...persisted, target: "mat_tampered" }
    await expect(persistRows(runtime, repos, runtime.audit.slice(0))).rejects.toBeInstanceOf(
      AuditAppendConflictError
    )
    const rows = await repos.audit.listByFirm("firmA")
    expect(rows.map((row) => row.target)).toEqual(["mat_a"])
  })
})
