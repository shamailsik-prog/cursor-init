// FA-F13-037: documents POST and document-workflow must fail closed on DocumentMalformedError from
// documents.get (no cache fallback / no create-from-cache). These kill mutants that re-enable fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as documentsPost } from "@/app/api/d1/documents/route"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { DocumentMalformedError } from "@/platform/d1/documentRecord"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import type { DocumentRecord } from "@/platform/spine/store"

const docId = "doc_f13_037_malformed"

function seedMatterAndDocument(): { matterId: string; doc: DocumentRecord } {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "F13-037 matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  const doc: DocumentRecord = {
    id: docId,
    firmId: "firmA",
    matterId: matter.id,
    contentHash: "sha256:ab",
    sourceChannel: "web",
    classification: "internal",
    storagePath: "firmA/obj",
    isImmutable: true,
    byteSize: 8,
    mimeType: "application/pdf",
    objectVersion: 1,
    uploadedBy: "partner_a",
    objectBytesStatus: "available",
  }
  store.documents.set(docId, doc)
  return { matterId: matter.id, doc }
}

vi.mock("@/platform/persistence/runtimeRepositories", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/platform/persistence/runtimeRepositories")>()
  let getImpl: SpineRepositories["documents"]["get"] | null = null
  return {
    ...mod,
    __setDocumentsGet(impl: SpineRepositories["documents"]["get"] | null) {
      getImpl = impl
    },
    getRuntimeRepositories: async (store: Parameters<typeof mod.getRuntimeRepositories>[0]) => {
      const repos = await mod.getRuntimeRepositories(store)
      if (!getImpl) return repos
      const base = repos.documents.get.bind(repos.documents)
      repos.documents.get = async (id, firmId) => {
        const out = await getImpl!(id, firmId)
        if (out !== undefined) return out
        return base(id, firmId)
      }
      return repos
    },
  }
})

type RepoSeam = { __setDocumentsGet: (impl: SpineRepositories["documents"]["get"] | null) => void }
const repoSeam = () => import("@/platform/persistence/runtimeRepositories") as Promise<RepoSeam>

describe("F13 FA-F13-037: malformed documents.get on routes", () => {
  beforeEach(() => {
    resetRuntimeStoreForTests()
    resetIdempotencyForTests()
  })
  afterEach(async () => {
    const seam = await repoSeam()
    seam.__setDocumentsGet(null)
  })

  it("POST ingest returns 500 and drops cache when the post-persist get throws DocumentMalformedError", async () => {
    const { matterId } = seedMatterAndDocument()
    let calls = 0
    const seam = await repoSeam()
    seam.__setDocumentsGet(async (id) => {
      calls += 1
      if (calls >= 2) throw new DocumentMalformedError(id)
    })
    const store = getRuntimeStore()
    const res = await documentsPost(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "a1b2c3d4-e5f6-4789-a012-3456789f0371",
        },
        body: JSON.stringify({
          action: "ingest",
          actorId: "partner_a",
          firmId: "firmA",
          matterId,
          contentBase64: Buffer.from("%PDF-f13-037%").toString("base64"),
          sourceChannel: "web",
          classification: "internal",
        }),
      })
    )
    expect(res.status).toBe(500)
    const created = [...store.documents.keys()].find((id) => id !== docId)
    expect(created).toBeTruthy()
    expect(store.documents.has(created!)).toBe(false)
  })

  it("workflow review_decision returns 400 and drops cache when documents.get throws DocumentMalformedError", async () => {
    seedMatterAndDocument()
    const seam = await repoSeam()
    seam.__setDocumentsGet(async (id) => {
      if (id === docId) throw new DocumentMalformedError(id)
    })
    const store = getRuntimeStore()
    const res = await workflowPost(
      new Request("http://127.0.0.1/api/d1/document-workflow", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "b2c3d4e5-f6a7-4890-b123-4567890f0372",
        },
        body: JSON.stringify({
          action: "review_decision",
          actorId: "partner_a",
          documentId: docId,
          decision: "confirm_classification",
        }),
      })
    )
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body).toMatchObject({ error: "unknown document" })
    expect(store.documents.has(docId)).toBe(false)
  })
})
