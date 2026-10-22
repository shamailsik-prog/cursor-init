import { afterEach, describe, expect, it, vi } from "vitest"
import { tryDispatchConsoleCallToFunctions } from "@/lib/console/console-functions-dispatch"
import { executeConsoleApiCall } from "@/lib/console/execute-console-api-call"
import {
  firestorePersistenceConfigured,
  resetProductionFirestoreForTests,
} from "@/platform/persistence/adminFirestore"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"

describe("FA-F01/F02 follow-up regressions", () => {
  describe("FA-F01-001 listByFirm uses firmId query", () => {
    it("queries Firestore with where(firmId) instead of scanning the collection", async () => {
      const where = vi.fn(() => ({
        limit: vi.fn(() => ({
          get: async () => ({
            // Audit F13: a canonical matter row (the shared validator never returns a partial one).
            docs: [{ id: "m1", data: () => ({ id: "m1", firmId: "firmA", title: "x", clientId: "c", status: "live", classification: "internal" }) }],
            empty: false,
          }),
        })),
      }))
      const adminDb = {
        collection: vi.fn(() => ({ where })),
      }
      const repos = createFirestoreRepositories(adminDb as never)
      const rows = await repos.matters.listByFirm("firmA")
      expect(adminDb.collection).toHaveBeenCalledWith("matters")
      expect(where).toHaveBeenCalledWith("firmId", "==", "firmA")
      expect(rows).toHaveLength(1)
    })
  })

  describe("FA-F01-002 firm-scoped get/update", () => {
    it("refuses cross-firm matter reads and updates", async () => {
      const store = new Map<string, { id: string; firmId: string; title: string } & Record<string, string>>([
        // Audit F13: a canonical matter row (the shared validator never returns a partial one).
        ["m1", { id: "m1", firmId: "firmA", title: "A matter", clientId: "c", status: "live", classification: "internal" }],
      ])
      const db = {
        collection: (_name: string) => ({
          doc: (id: string) => ({
            get: async () => ({
              exists: store.has(id),
              data: () => store.get(id),
            }),
            update: async (patch: Record<string, unknown>) => {
              const cur = store.get(id)
              if (cur) store.set(id, { ...cur, ...patch } as typeof cur)
            },
          }),
          where: (field: string, _op: string, value: string) => ({
            get: async () => ({
              docs: [...store.values()]
                .filter((row) => row[field as keyof typeof row] === value)
                .map((row) => ({ id: row.id, data: () => row })),
              empty: false,
            }),
          }),
        }),
      }
      const repos = createFirestoreRepositories(db as never)
      expect(await repos.matters.get("m1", "firmB")).toBeNull()
      expect(await repos.matters.get("m1", "firmA")).toMatchObject({ title: "A matter" })
      const blocked = await repos.matters.update("m1", "firmA", { firmId: "firmB", title: "hijack" })
      expect(blocked).toBeNull()
      expect(store.get("m1")?.title).toBe("A matter")
      const ok = await repos.matters.update("m1", "firmA", { title: "renamed" })
      expect(ok?.title).toBe("renamed")
    })
  })

  describe("FA-F01-003 production ADC and emulator refusal", () => {
    const env = process.env as Record<string, string | undefined>
    const saved = { ...env }

    afterEach(() => {
      Object.assign(env, saved)
      resetProductionFirestoreForTests()
    })

    it("accepts Cloud Run ADC without project env vars or GOOGLE_APPLICATION_CREDENTIALS", () => {
      env.NODE_ENV = "production"
      delete env.GOOGLE_APPLICATION_CREDENTIALS
      delete env.FIRESTORE_EMULATOR_HOST
      delete env.GCLOUD_PROJECT
      delete env.GOOGLE_CLOUD_PROJECT
      env.K_SERVICE = "sikander-api"
      expect(firestorePersistenceConfigured(env as NodeJS.ProcessEnv)).toBe(true)
    })

    it("refuses Firestore emulator when NODE_ENV=production", () => {
      env.NODE_ENV = "production"
      env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
      expect(firestorePersistenceConfigured(env as NodeJS.ProcessEnv)).toBe(false)
    })
  })

  describe("FA-F02-001/002 committee-brain dispatch validation", () => {
    it("returns 400 for non-string body.body and missing classification", async () => {
      const badBody = await tryDispatchConsoleCallToFunctions(
        { idToken: "t", firmId: "firmA" },
        { method: "POST", path: "/api/p1/committee-brain", body: { body: 123 } }
      )
      expect(badBody).toMatchObject({ ok: false, status: 400 })

      const noClass = await tryDispatchConsoleCallToFunctions(
        { idToken: "t", firmId: "firmA" },
        { method: "POST", path: "/api/p1/committee-brain", body: { body: "text" } }
      )
      expect(noClass).toMatchObject({ ok: false, status: 400 })
    })

    it("does not fall back to Next when committee-brain body is invalid", async () => {
      const nextFetch = vi.fn()
      const result = await executeConsoleApiCall(
        { idToken: "t", firmId: "firmA" },
        { method: "POST", path: "/api/p1/committee-brain", body: { body: false } },
        { fetchImpl: nextFetch }
      )
      expect(result.transport).toBe("functions")
      expect(result.status).toBe(400)
      expect(nextFetch).not.toHaveBeenCalled()
    })
  })
})
