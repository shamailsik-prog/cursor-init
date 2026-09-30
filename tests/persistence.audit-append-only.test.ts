import { describe, expect, it } from "vitest"
import {
  AuditAppendConflictError,
  createMemoryRepositories,
} from "@/platform/persistence/spineRepositories"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { newStore, type AuditEntry } from "@/platform/spine/store"

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

  it("rejects an identical replay of an existing audit id (insert-only, no silent upsert)", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    await repos.audit.append(auditRow())
    await expect(repos.audit.append(auditRow())).rejects.toBeInstanceOf(AuditAppendConflictError)
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
    await persistAuditEntriesSince(store, repos, prior)
    const ids = store.audit.slice(prior).map((row) => row.id)
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(store.audit).toHaveLength(prior + 2)
  })
})
