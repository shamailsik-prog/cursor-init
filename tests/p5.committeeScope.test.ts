/**
 * Committee Brain scope (platform/p5/committeeScope.ts), unit level: matter
 * access through P5, repository hydration, the max-of-labels classification,
 * the document/matter binding and the party names handed to the masker.
 * Written against the surviving mutants of `npm run mutation`
 * (docs/audits/mutation-report.md); until now only the route exercised it.
 */
import { describe, expect, it } from "vitest"
import {
  CommitteeScopeError,
  MOST_RESTRICTIVE,
  canAccessMatter,
  resolveCommitteeScope,
  strictestClassification,
} from "@/platform/p5/committeeScope"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import {
  newStore,
  type DocumentRecord,
  type Entity,
  type Matter,
  type MatterMember,
  type User,
} from "@/platform/spine/store"
import type { Classification } from "@/platform/p1/types"

const actor: User = { id: "u1", firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" }

function matter(id: string, classification: Classification = "internal", firmId = "firmA"): Matter {
  return {
    id,
    firmId,
    clientId: "client_1",
    title: id,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification,
  }
}

function doc(id: string, matterId: string | null, classification: Classification = "internal", firmId = "firmA"): DocumentRecord {
  return {
    id,
    firmId,
    matterId,
    contentHash: id,
    sourceChannel: "web",
    classification,
    storagePath: `r2://${firmId}/documents/${id}/v1`,
    isImmutable: false,
    byteSize: 0,
    mimeType: "application/octet-stream",
    objectVersion: 1,
    uploadedBy: "partner_a",
  }
}

function client(firmId = "firmA", canonicalName = "Muhammad Ali"): Entity {
  return { id: "client_1", firmId, canonicalName, cnic: "", phone: "", classification: "confidential" }
}

/** Repositories backed by plain maps (the "durable" side; the store is the per-instance cache). */
function repos(seed: {
  matters?: Matter[]
  members?: MatterMember[]
  entities?: Entity[]
  documents?: DocumentRecord[]
}): SpineRepositories {
  const by = <T extends { id: string }>(rows: T[] = []) => new Map(rows.map((r) => [r.id, r]))
  const matters = by(seed.matters)
  const entities = by(seed.entities)
  const documents = by(seed.documents)
  const members = new Map((seed.members ?? []).map((m) => [`${m.matterId}_${m.userId}`, m]))
  return {
    matters: { get: async (id: string) => matters.get(id) ?? null },
    members: { get: async (matterId: string, userId: string) => members.get(`${matterId}_${userId}`) ?? null },
    entities: { get: async (id: string) => entities.get(id) ?? null },
    documents: { get: async (id: string) => documents.get(id) ?? null },
  } as unknown as SpineRepositories
}

function storeWith(opts: { matter?: Matter; member?: boolean; documents?: DocumentRecord[]; entity?: Entity } = {}) {
  const store = newStore()
  store.users.set(actor.id, actor)
  if (opts.matter) store.matters.set(opts.matter.id, opts.matter)
  if (opts.member && opts.matter) {
    store.members.set(store.memberKey(opts.matter.id, actor.id), { matterId: opts.matter.id, userId: actor.id, firmId: "firmA" })
  }
  for (const d of opts.documents ?? []) store.documents.set(d.id, d)
  if (opts.entity) store.entities.set(opts.entity.id, opts.entity)
  return store
}

async function scopeError(p: Promise<unknown>): Promise<CommitteeScopeError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CommitteeScopeError)
  return err as CommitteeScopeError
}

describe("strictestClassification", () => {
  it("returns the highest-ranked label, or null for none", () => {
    expect(strictestClassification([])).toBeNull()
    expect(strictestClassification(["internal", "privileged", "confidential"])).toBe("privileged")
    expect(strictestClassification(["public"])).toBe("public")
  })

  it("is privileged-restricted for the unreadable-label fallback", () => {
    expect(MOST_RESTRICTIVE).toBe("privileged-restricted")
  })
})

describe("canAccessMatter", () => {
  it("reports an unknown matter without consulting P5", async () => {
    const store = storeWith()
    expect(await canAccessMatter(store, repos({}), actor, "m_missing")).toEqual({
      allow: false,
      reason: "unknown-matter",
      matter: null,
    })
  })

  it("prefers the store's matter and does not overwrite it from the repository", async () => {
    const cached = matter("m1", "confidential")
    const store = storeWith({ matter: cached, member: true })
    const decision = await canAccessMatter(store, repos({ matters: [] }), actor, "m1")
    expect(decision).toEqual({ allow: true, reason: "ok", matter: cached })
  })

  it("hydrates the matter and the membership row from the repository", async () => {
    const m = matter("m1", "confidential")
    const store = storeWith()
    const decision = await canAccessMatter(
      store,
      repos({ matters: [m], members: [{ matterId: "m1", userId: actor.id, firmId: "firmA" }] }),
      actor,
      "m1"
    )
    expect(decision).toEqual({ allow: true, reason: "ok", matter: m })
    expect(store.matters.get("m1")).toBe(m)
    expect(store.members.has(store.memberKey("m1", actor.id))).toBe(true)
  })

  it("denies a non-member (no membership in store or repository) through P5", async () => {
    const store = storeWith({ matter: matter("m1") })
    expect(await canAccessMatter(store, repos({}), actor, "m1")).toMatchObject({ allow: false, reason: "not-member" })
    expect(store.members.has(store.memberKey("m1", actor.id))).toBe(false)
  })

  it("keeps a membership already in the store without asking the repository", async () => {
    const store = storeWith({ matter: matter("m1"), member: true })
    const failing = {
      ...repos({}),
      members: {
        get: async () => {
          throw new Error("repository must not be read for a cached membership")
        },
      },
    } as unknown as SpineRepositories
    expect(await canAccessMatter(store, failing, actor, "m1")).toMatchObject({ allow: true })
  })

  it("passes the committee_brain action to P5 (an intern is not denied as for research/draft)", async () => {
    const intern: User = { ...actor, id: "intern1", role: "intern" }
    const store = storeWith({ matter: matter("m1") })
    store.users.set(intern.id, intern)
    store.members.set(store.memberKey("m1", intern.id), { matterId: "m1", userId: intern.id, firmId: "firmA" })
    expect(await canAccessMatter(store, repos({}), intern, "m1")).toMatchObject({ allow: true, reason: "ok" })
    expect(await canAccessMatter(store, repos({}), intern, "m1", "research")).toMatchObject({
      allow: false,
      reason: "intern-channel-denied",
    })
  })
})

describe("resolveCommitteeScope", () => {
  it("404 NOT_FOUND for an unknown matter", async () => {
    const err = await scopeError(resolveCommitteeScope(storeWith(), repos({}), actor, { matterId: "nope" }))
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND", message: "unknown matter", name: "CommitteeScopeError" })
  })

  it("403 FORBIDDEN naming the P5 reason when access is denied", async () => {
    const err = await scopeError(
      resolveCommitteeScope(storeWith({ matter: matter("m1") }), repos({}), actor, { matterId: "m1" })
    )
    expect(err).toMatchObject({ status: 403, code: "FORBIDDEN", message: "permission denied: not-member" })
  })

  it("uses the matter's label when no documents are referenced, with the client's name as a party", async () => {
    const store = storeWith({ matter: matter("m1", "confidential"), member: true, entity: client() })
    expect(await resolveCommitteeScope(store, repos({}), actor, { matterId: "m1" })).toEqual({
      classification: "confidential",
      matterId: "m1",
      documentIds: [],
      partyNames: ["Muhammad Ali"],
    })
  })

  it("reads the client from the repository when the store has none", async () => {
    const store = storeWith({ matter: matter("m1"), member: true })
    const scope = await resolveCommitteeScope(store, repos({ entities: [client()] }), actor, { matterId: "m1" })
    expect(scope.partyNames).toEqual(["Muhammad Ali"])
  })

  it("never takes a party name from another firm's client record, or a nameless one", async () => {
    const other = storeWith({ matter: matter("m1"), member: true, entity: client("firmB") })
    expect((await resolveCommitteeScope(other, repos({}), actor, { matterId: "m1" })).partyNames).toEqual([])
    const nameless = storeWith({ matter: matter("m1"), member: true, entity: client("firmA", "") })
    expect((await resolveCommitteeScope(nameless, repos({}), actor, { matterId: "m1" })).partyNames).toEqual([])
  })

  it("refuses a matter whose label is unreadable (403 clearance), even to a privileged-restricted partner", async () => {
    // Final audit I-3: checkPermission (the shared decision table) refuses an unreadable matter
    // classification outright, so the scope is never built; it used to be read as
    // privileged-restricted, which a privileged-restricted caller could pass.
    const m = { ...matter("m1"), classification: "bogus" } as unknown as Matter
    const store = storeWith({ matter: m, member: true })
    const err = await scopeError(resolveCommitteeScope(store, repos({}), actor, { matterId: "m1" }))
    expect(err).toMatchObject({ status: 403, code: "FORBIDDEN", message: "permission denied: clearance" })
  })

  it("raises the label to the strictest referenced document and de-duplicates ids", async () => {
    const store = storeWith({
      matter: matter("m1", "internal"),
      member: true,
      documents: [doc("d1", "m1", "privileged"), doc("d2", "m1", "confidential")],
    })
    expect(
      await resolveCommitteeScope(store, repos({}), actor, { matterId: "m1", documentIds: ["d1", "d2", "d1"] })
    ).toEqual({ classification: "privileged", matterId: "m1", documentIds: ["d1", "d2"], partyNames: [] })
  })

  it("prefers the store's document over the repository's copy", async () => {
    const store = storeWith({ matter: matter("m1"), member: true, documents: [doc("d1", "m1", "confidential")] })
    const scope = await resolveCommitteeScope(store, repos({ documents: [] }), actor, { matterId: "m1", documentIds: ["d1"] })
    expect(scope.classification).toBe("confidential")
  })

  it("reads a document from the repository when the store has none", async () => {
    const store = storeWith({ matter: matter("m1"), member: true })
    const scope = await resolveCommitteeScope(store, repos({ documents: [doc("d1", "m1", "privileged")] }), actor, {
      matterId: "m1",
      documentIds: ["d1"],
    })
    expect(scope.classification).toBe("privileged")
  })

  it("treats an unreadable document label as privileged-restricted", async () => {
    const bad = { ...doc("d1", "m1"), classification: 7 } as unknown as DocumentRecord
    const store = storeWith({ matter: matter("m1"), member: true, documents: [bad] })
    const scope = await resolveCommitteeScope(store, repos({}), actor, { matterId: "m1", documentIds: ["d1"] })
    expect(scope.classification).toBe("privileged-restricted")
  })

  it("reports a missing or another firm's document as 404 unknown document (no existence oracle)", async () => {
    for (const documents of [[], [doc("d1", "m1", "internal", "firmB")]]) {
      const store = storeWith({ matter: matter("m1"), member: true, documents })
      const err = await scopeError(resolveCommitteeScope(store, repos({}), actor, { matterId: "m1", documentIds: ["d1"] }))
      expect(err).toMatchObject({ status: 404, code: "NOT_FOUND", message: "unknown document" })
    }
  })

  it("403 document_matter_mismatch for a document of another matter or of no matter", async () => {
    for (const d of [doc("d1", "m2"), doc("d1", null)]) {
      const store = storeWith({ matter: matter("m1"), member: true, documents: [d] })
      const err = await scopeError(resolveCommitteeScope(store, repos({}), actor, { matterId: "m1", documentIds: ["d1"] }))
      expect(err).toMatchObject({
        status: 403,
        code: "document_matter_mismatch",
        message: "document does not belong to the referenced matter",
      })
    }
  })
})
