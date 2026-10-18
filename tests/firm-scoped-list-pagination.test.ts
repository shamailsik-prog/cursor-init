import { describe, expect, it, vi } from "vitest"
import { FirmScopedCursorError } from "@/platform/persistence/firestoreDbModular"
import {
  FIRM_SCOPED_LIST_MAX_PAGES,
  listAllRowsByFirm,
  listAllRowsByFirmAndField,
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

describe("complete firm-scoped listings (takeover of #44: no silent truncation)", () => {
  /** An admin-style mock: `where(firmId).limit(n)` pages ordered by id, `startAfter(snapshot)` resumes after it. */
  function pagedDb(rows: Array<{ id: string; firmId: string }>) {
    const calls = { pages: 0, cursorReads: 0 }
    const page = (start: number, n: number) => ({
      get: async () => {
        calls.pages += 1
        const slice = rows.slice(start, start + n)
        return { docs: slice.map((row) => ({ id: row.id, data: () => row, ref: { id: row.id } })), empty: slice.length === 0 }
      },
    })
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            calls.cursorReads += 1
            return { exists: false, data: () => undefined }
          },
        }),
        where: (_f: string, _o: string, firmId: string) => ({
          limit: (n: number) => ({
            ...page(0, n),
            startAfter: (snap: { id: string }) => page(rows.findIndex((row) => row.id === snap.id) + 1, n),
          }),
          where: () => {
            throw new Error(`unexpected second filter for ${firmId}`)
          },
        }),
      }),
    }
    return { db, calls }
  }

  it("listAllRowsByFirm returns every row across pages, resuming from the SDK snapshot (no cursor re-read)", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, firmId: "firmA" }))
    const { db, calls } = pagedDb(rows)
    const all = await listAllRowsByFirm(db as never, "matters", "firmA", 3)
    expect(all.items.map((row) => row.id)).toEqual(rows.map((row) => row.id))
    expect(all.truncated).toBe(false)
    expect(all.nextCursor).toBeNull()
    expect(calls.pages).toBe(3)
    expect(calls.cursorReads).toBe(0)
  })

  it("a page that is exactly full still reads the next (empty) page before it stops", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, firmId: "firmA" }))
    const { db } = pagedDb(rows)
    const all = await listAllRowsByFirm(db as never, "matters", "firmA", 3)
    expect(all.items).toHaveLength(6)
  })

  it("fails loudly, never truncates, when the query does not advance", async () => {
    const stuck = {
      collection: () => ({
        where: () => ({
          limit: (n: number) => {
            const q = {
              get: async () => ({
                docs: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, data: () => ({ id: `s${i}`, firmId: "firmA" }) })),
                empty: false,
              }),
              startAfter: () => q,
            }
            return q
          },
        }),
      }),
    }
    await expect(listAllRowsByFirm(stuck as never, "matters", "firmA", 1)).rejects.toThrow(
      `exceeded ${FIRM_SCOPED_LIST_MAX_PAGES} pages`
    )
  })

  it("listAllRowsByFirmAndField refuses an empty caller firm", async () => {
    await expect(listAllRowsByFirmAndField({} as never, "matter_members", "", "matterId", "m1")).rejects.toThrow(
      /caller firmId is required/
    )
  })
})
