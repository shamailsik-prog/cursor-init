// Audit F13: the single validator of the canonical matter / membership shape (platform/d1/matterDocument.ts), and the
// wiring that makes it the only one: both API stacks import it. The contract tests that run both stacks against the
// same documents on the emulators are tests/f13-canonical-matter-shapes.e2e.firestore.test.ts.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildMatterSearchIndexRow } from "@/platform/persistence/matterClientSearchIndex"
import type { Matter } from "@/platform/spine/store"
import {
  MATTER_STAGES,
  MatterShapeError,
  canonicalMatterDocument,
  canonicalMatterMemberDocument,
  isCanonicalMatterMemberRow,
  readMatterDocument,
} from "@/platform/d1/matterDocument"
import { PublicError } from "@/platform/http/publicError"
import { newStore } from "@/platform/spine/store"
import { confirmEngagement } from "@/services/d1-2/matters"

/** Exactly what Cloud Functions openMatter stored before the fix (no court given). */
const functionsRow = {
  firmId: "firmA",
  matterNo: "NHS/2026/0001",
  stage: "filed",
  status: "engagement_unconfirmed",
  clientId: "client_1",
  conflictCheckId: "check_1",
  title: "Recovery suit",
  classification: "confidential",
  createdBy: "partner_1",
  createdAt: { seconds: 1, nanoseconds: 0 },
}

/** Exactly what the Next matters route stored before the fix. */
const nextRow = {
  id: "mat_1",
  firmId: "firmA",
  clientId: "client_1",
  title: "Next matter",
  courtId: "SHC",
  caseNumber: null,
  caseNumberStatus: "pending",
  status: "live",
  classification: "internal",
}

describe("F13: readMatterDocument, the one validator both stacks read and write through", () => {
  it("reads a Functions row with the fields Functions never wrote defaulted (courtId, caseNumber, caseNumberStatus)", () => {
    expect(readMatterDocument(functionsRow)).toEqual({
      ...functionsRow,
      courtId: null,
      caseNumber: null,
      caseNumberStatus: "pending",
    })
  })

  it("reads a legacy Next row at pre_filing, with no matterNo, check or creator, and drops the stored id", () => {
    const { id: _id, ...rest } = nextRow
    expect(readMatterDocument(nextRow)).toEqual({ ...rest, stage: "pre_filing", matterNo: null, conflictCheckId: null, createdBy: null })
    expect(readMatterDocument(nextRow)).not.toHaveProperty("id")
  })

  it("keeps a recorded case number and every stored lifecycle field", () => {
    const row = { ...functionsRow, status: "closed", courtId: "LHC", caseNumber: "C.P. 1/2026", caseNumberStatus: "recorded", closedBy: "p" }
    expect(readMatterDocument(row)).toEqual(row)
  })

  it.each([
    ["status outside the canonical set", { status: "archived_by_hand" }],
    ["no status", { status: undefined }],
    ["stage outside the canonical set", { stage: "appeal" }],
    ["stage null", { stage: null }],
    ["classification unknown", { classification: "secret" }],
    ["caseNumberStatus unknown", { caseNumberStatus: "maybe" }],
    ["caseNumber not a string", { caseNumber: 12 }],
    ["courtId not a string", { courtId: 7 }],
    ["matterNo not a string", { matterNo: 1 }],
    ["conflictCheckId not a string", { conflictCheckId: true }],
    ["createdBy not a string", { createdBy: {} }],
    ["empty firmId", { firmId: " " }],
    ["no firmId", { firmId: undefined }],
    ["no clientId", { clientId: undefined }],
    ["empty clientId", { clientId: "" }],
    ["title not a string", { title: 5 }],
  ])("refuses a row with %s (both stacks: Next returns nothing, Functions answers 409 matter_malformed)", (_label, patch) => {
    const row = { ...functionsRow, ...patch }
    expect(readMatterDocument(row)).toBeNull()
    expect(() => canonicalMatterDocument(row)).toThrow(MatterShapeError)
  })

  it.each([null, undefined, "matter", 3, [functionsRow]])("refuses a non-object (%s)", (value) => {
    expect(readMatterDocument(value)).toBeNull()
  })

  it("canonicalMatterDocument returns the same document readMatterDocument reads, and its error carries matter_malformed", () => {
    expect(canonicalMatterDocument(functionsRow)).toEqual(readMatterDocument(functionsRow))
    try {
      canonicalMatterDocument({ ...functionsRow, status: "x" })
      throw new Error("expected a MatterShapeError")
    } catch (err) {
      expect(err).toBeInstanceOf(MatterShapeError)
      expect((err as MatterShapeError).code).toBe("matter_malformed")
      expect((err as Error).message).toContain("status")
    }
  })
})

describe("F13: the canonical membership row", () => {
  const member = { firmId: "firmA", matterId: "mat_1", userId: "u1", addedBy: "p1", classification: "internal" }

  it("builds exactly the Functions membership fields", () => {
    expect(canonicalMatterMemberDocument(member)).toEqual(member)
    expect(canonicalMatterMemberDocument({ ...member, addedBy: undefined })).toEqual({ ...member, addedBy: null })
  })

  it.each([
    ["no classification", { classification: undefined }],
    ["unknown classification", { classification: "secret" }],
    ["addedBy not a string", { addedBy: 1 }],
    ["empty firmId", { firmId: "" }],
    ["empty matterId", { matterId: "" }],
    ["empty userId", { userId: "" }],
  ])("refuses a membership with %s", (_label, patch) => {
    expect(() => canonicalMatterMemberDocument({ ...member, ...patch })).toThrow(MatterShapeError)
  })

  it("a stored row is complete only with its own keys, a classification and a createdAt", () => {
    const stored = { ...member, createdAt: { seconds: 1 } }
    expect(isCanonicalMatterMemberRow(stored, "mat_1", "u1", "firmA")).toBe(true)
    expect(isCanonicalMatterMemberRow({ matterId: "mat_1", userId: "u1", firmId: "firmA" }, "mat_1", "u1", "firmA")).toBe(false)
    expect(isCanonicalMatterMemberRow({ ...stored, createdAt: null }, "mat_1", "u1", "firmA")).toBe(false)
    expect(isCanonicalMatterMemberRow({ ...stored, classification: "x" }, "mat_1", "u1", "firmA")).toBe(false)
    expect(isCanonicalMatterMemberRow(stored, "mat_1", "u1", "firmB")).toBe(false)
    expect(isCanonicalMatterMemberRow(stored, "mat_2", "u1", "firmA")).toBe(false)
    expect(isCanonicalMatterMemberRow(stored, "mat_1", "u2", "firmA")).toBe(false)
    expect(isCanonicalMatterMemberRow(null, "mat_1", "u1", "firmA")).toBe(false)
  })
})

describe("F13: one schema owner, imported by both stacks", () => {
  const root = path.resolve(__dirname, "..")
  const source = (rel: string) => readFileSync(path.join(root, rel), "utf8")

  it("Cloud Functions matter ops read and write through the shared module and take its stages", () => {
    const ops = source("functions/src/d1/matter/ops.ts")
    expect(ops).toMatch(/from "@\/platform\/d1\/matterDocument"/)
    for (const name of ["readMatterDocument", "canonicalMatterDocument", "canonicalMatterMemberDocument", "MATTER_STAGES"]) expect(ops).toContain(name)
    expect(ops).not.toMatch(/export const STAGES = \[/)
  })

  it("the Next Firestore repositories read and write matters and memberships through the shared module", () => {
    const repo = source("platform/persistence/firestoreSpineRepositories.ts")
    expect(repo).toMatch(/from "@\/platform\/d1\/matterDocument"/)
    for (const name of ["readMatterDocument", "canonicalMatterDocument", "canonicalMatterMemberDocument", "isCanonicalMatterMemberRow"]) expect(repo).toContain(name)
    expect(repo).not.toMatch(/getById<Matter>/)
  })

  it("the stage list is the one Functions has always enforced", () => {
    expect(MATTER_STAGES).toEqual(["pre_filing", "filed", "hearing", "reserved", "decided", "archived"])
  })
})

describe("F13: the canonical status set includes closed", () => {
  it("confirmEngagement never reopens a closed matter (a Cloud Functions closeMatter transition)", () => {
    const store = newStore()
    const matter = { ...nextRow, id: "mat_closed", status: "closed" as const, courtId: null, caseNumberStatus: "pending" as const, classification: "internal" as const }
    store.matters.set(matter.id, matter)
    expect(() => confirmEngagement(store, matter.id)).toThrow(PublicError)
    expect(store.matters.get(matter.id)?.status).toBe("closed")
  })
})

// FA-F13-008: the two read-side null-court paths, each guarded by a test that fails on its revert (mutants M8, M10).
describe("F13 re-audit: null-court read paths", () => {
  const base: Matter = {
    id: "m_null_court",
    firmId: "firm_a",
    clientId: "client_a",
    title: "Recovery suit",
    classification: "internal",
    status: "engagement_unconfirmed",
    courtId: null,
    caseNumber: null,
    caseNumberStatus: "pending",
  }

  it("M8: the search index row of a matter with no court and no case number has an empty detail", () => {
    // Revert of `?? ""` (matterClientSearchIndex.ts) leaves detail null. A case number wins over the court,
    // the court is used only when the case number is null, and an empty case number does not fall through.
    const row = buildMatterSearchIndexRow(base, { updatedAt: 1 })
    expect(row.detail).toBe("")
    expect(row.tags).not.toContain("null")
    expect(buildMatterSearchIndexRow({ ...base, caseNumber: "CP 12/2019", courtId: "SHC" }, { updatedAt: 1 }).detail).toBe("CP 12/2019")
    expect(buildMatterSearchIndexRow({ ...base, caseNumber: null, courtId: "SHC" }, { updatedAt: 1 }).detail).toBe("SHC")
    expect(buildMatterSearchIndexRow({ ...base, caseNumber: "", courtId: "SHC" }, { updatedAt: 1 }).detail).toBe("")
  })

  it("M10: a matter with no court admits no court mentioned around its recorded number (fails closed)", async () => {
    const { ownCaseReferenceMatcher } = await import("@/services/d4-1/drafts")
    const isOwn = ownCaseReferenceMatcher({ courtId: null, caseNumber: "CP 12/2019" })
    expect(isOwn("CP 12/2019", { before: "The Supreme Court in", after: "held" })).toBe(false)
    expect(isOwn("CP 12/2019", { before: "The Sindh High Court in", after: "held" })).toBe(false)
  })
})
