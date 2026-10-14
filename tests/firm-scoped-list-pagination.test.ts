import { describe, expect, it, vi } from "vitest"
import { FirmScopedCursorError } from "@/platform/persistence/firestoreDbModular"
import {
  listRowsByFirm,
  listRowsByFirmAndField,
} from "@/platform/persistence/firmScopedList"

describe("firm-scoped list pagination", () => {
  it("admin: limit+1 truncation and nextCursor", async () => {
    const docs = Array.from({ length: 3 }, (_, i) => ({
      id: `d${i}`,
      firmId: "firmA",
      title: `t${i}`,
    }))
    const db = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: Boolean(docs.find((d) => d.id === id)),
            data: () => docs.find((d) => d.id === id),
          }),
        }),
        where: () => ({
          limit: (n: number) => ({
            startAfter: (snap: { data: () => unknown }) => ({
              get: async () => {
                const cursorId = (snap.data() as { id: string }).id
                const start = Number(cursorId.replace("d", "")) + 1
                const slice = docs.slice(start, start + n)
                return {
                  docs: slice.map((row) => ({ id: row.id, data: () => row })),
                }
              },
            }),
            get: async () => ({
              docs: docs.slice(0, n).map((row) => ({ id: row.id, data: () => row })),
            }),
          }),
        }),
      }),
    }
    const page = await listRowsByFirm(db as never, "matters", "firmA", { limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.truncated).toBe(true)
    expect(page.nextCursor).toBe("d1")
    const page2 = await listRowsByFirm(db as never, "matters", "firmA", {
      limit: 2,
      startAfterId: "d1",
    })
    expect(page2.items.map((r) => r.id)).toEqual(["d2"])
    expect(page2.truncated).toBe(false)
  })

  it("client path: listRowsByFirm applies withFirmQueryStartAfter when startAfterId is set", async () => {
    const modular = await import("@/platform/persistence/firestoreDbModular")
    const startAfterSpy = vi
      .spyOn(modular, "withFirmQueryStartAfter")
      .mockImplementation((_db, query) => query)
    vi.spyOn(modular, "validateFirmListCursor").mockResolvedValue({ id: "d0" })
    vi.spyOn(modular, "queryByFirmId").mockReturnValue({ marker: "base" } as never)
    vi.spyOn(modular, "getDocs").mockResolvedValue({
      docs: [{ id: "d1", data: () => ({ id: "d1", firmId: "firmA" }) }],
      empty: false,
    })
    await listRowsByFirm({} as never, "matters", "firmA", { startAfterId: "d0", limit: 5 })
    expect(startAfterSpy).toHaveBeenCalled()
    startAfterSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("rejects invalid and cross-firm cursors", async () => {
    const db = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: id === "cursorA",
            data: () => ({ id: "cursorA", firmId: id === "cursorA" ? "firmB" : "firmA" }),
          }),
        }),
        where: () => ({
          limit: () => ({
            get: async () => ({ docs: [] }),
          }),
        }),
      }),
    }
    await expect(
      listRowsByFirm(db as never, "matters", "firmA", { startAfterId: "missing" })
    ).rejects.toBeInstanceOf(FirmScopedCursorError)
    await expect(
      listRowsByFirm(db as never, "matters", "firmA", { startAfterId: "cursorA" })
    ).rejects.toMatchObject({ message: "cross-firm cursor" })
  })

  it("listRowsByFirmAndField honours startAfterId", async () => {
    const rows = [
      { id: "a0", firmId: "firmA", matterId: "m1" },
      { id: "a1", firmId: "firmA", matterId: "m1" },
      { id: "a2", firmId: "firmA", matterId: "m1" },
    ]
    const db = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => {
            const row = rows.find((r) => r.id === id)
            return { exists: Boolean(row), data: () => row }
          },
        }),
        where: (_f1: string, _o1: string, _v1: string) => ({
          where: (_f2: string, _o2: string, _v2: string) => ({
            limit: (n: number) => ({
              startAfter: () => ({
                get: async () => ({
                  docs: rows.slice(2, 2 + n).map((row) => ({ id: row.id, data: () => row })),
                }),
              }),
              get: async () => ({
                docs: rows.slice(0, n).map((row) => ({ id: row.id, data: () => row })),
              }),
            }),
          }),
        }),
      }),
    }
    const page = await listRowsByFirmAndField(
      db as never,
      "workflow_ops_activity",
      "firmA",
      "matterId",
      "m1",
      { limit: 2 }
    )
    expect(page.truncated).toBe(true)
    const page2 = await listRowsByFirmAndField(
      db as never,
      "workflow_ops_activity",
      "firmA",
      "matterId",
      "m1",
      { limit: 2, startAfterId: "a1" }
    )
    expect(page2.items.map((r) => r.id)).toEqual(["a2"])
  })
})
