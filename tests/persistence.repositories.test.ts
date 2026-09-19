import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"

const RULES = readFileSync("firestore.rules", "utf8")

let env: RulesTestEnvironment

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "sikander-persistence-adapters",
    firestore: { rules: RULES },
  })
})

afterAll(async () => {
  await env.cleanup()
})

describe("Firestore repository adapters", () => {
  it("round-trips matters/documents/drafts/workflow/filings without secrets (emulator)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      const repos = createFirestoreRepositories(db)

      await repos.users.upsert({
        id: "associate_a",
        firmId: "firmA",
        role: "associate",
        clearanceLevel: "privileged",
      })
      const persistedUser = await repos.users.get("associate_a")
      expect(persistedUser?.role).toBe("associate")
      const firmUsers = await repos.users.listByFirm("firmA")
      expect(firmUsers.some((row) => row.id === "associate_a")).toBe(true)

      await repos.matters.create({
        id: "mat_1",
        firmId: "firmA",
        clientId: "client_a",
        title: "Persisted matter",
        courtId: "SHC",
        caseNumber: null,
        caseNumberStatus: "pending",
        status: "engagement_unconfirmed",
        classification: "internal",
      })
      const matter = await repos.matters.get("mat_1")
      expect(matter?.title).toBe("Persisted matter")
      const matterRows = await repos.matters.listByFirm("firmA")
      expect(matterRows.some((row) => row.id === "mat_1")).toBe(true)
      await repos.members.upsert({
        matterId: "mat_1",
        userId: "associate_a",
        firmId: "firmA",
      })
      const member = await repos.members.get("mat_1", "associate_a")
      expect(member?.firmId).toBe("firmA")
      const members = await repos.members.listByMatter("mat_1")
      expect(members.some((row) => row.userId === "associate_a")).toBe(true)

      await repos.documents.create({
        id: "doc_1",
        firmId: "firmA",
        matterId: "mat_1",
        contentHash: "hash-1",
        sourceChannel: "web",
        classification: "internal",
      })
      const doc = await repos.documents.get("doc_1")
      expect(doc?.contentHash).toBe("hash-1")
      await repos.jobs.create({
        id: "job_1",
        firmId: "firmA",
        jobType: "ocr",
        documentId: "doc_1",
        classification: "internal",
        idempotencyKey: "idem-1",
      })
      const docJobs = await repos.jobs.listByDocument("doc_1")
      expect(docJobs.some((row) => row.id === "job_1")).toBe(true)

      await repos.drafts.create({
        id: "drf_1",
        firmId: "firmA",
        matterId: "mat_1",
        templateId: "motion",
        title: "Draft 1",
        body: "Body",
        classification: "internal",
        createdBy: "associate_a",
        createdAt: 1,
        status: "draft",
      })
      const draft = await repos.drafts.get("drf_1")
      expect(draft?.title).toBe("Draft 1")

      await repos.workflow.createOrUpdate({
        documentId: "doc_1",
        firmId: "firmA",
        matterId: "mat_1",
        status: "review_required",
        reviewerId: "associate_a",
        updatedAt: 2,
      })
      const workflow = await repos.workflow.get("doc_1")
      expect(workflow?.status).toBe("review_required")
      await repos.workflowEvents.append({
        id: "wfe_1",
        documentId: "doc_1",
        firmId: "firmA",
        matterId: "mat_1",
        actorId: "associate_a",
        action: "status_transition",
        status: "review_required",
        classification: "internal",
        reason: "moved to review",
        at: 4,
      })
      const events = await repos.workflowEvents.listByFirm("firmA")
      expect(events.some((row) => row.id === "wfe_1")).toBe(true)

      await repos.followUps.upsert({
        id: "fu_1",
        firmId: "firmA",
        matterId: "mat_1",
        courtId: "SHC",
        raw: "CP 1234",
        kind: "case_number_reject",
        status: "open",
      })
      const followUp = await repos.followUps.get("fu_1")
      expect(followUp?.kind).toBe("case_number_reject")
      await repos.followUps.upsert({
        ...(followUp as NonNullable<typeof followUp>),
        status: "resolved",
        resolvedBy: "associate_a",
        resolvedAt: 5,
      })
      const followUps = await repos.followUps.listByFirm("firmA")
      expect(followUps.some((row) => row.id === "fu_1" && row.status === "resolved")).toBe(true)

      await repos.intimations.upsert({
        id: "int_1",
        firmId: "firmA",
        matterId: "mat_1",
        notifiedAt: 10,
        confirmedAt: null,
      })
      const intimation = await repos.intimations.get("int_1")
      expect(intimation?.matterId).toBe("mat_1")
      const matterIntimations = await repos.intimations.listByMatter("mat_1")
      expect(matterIntimations.some((row) => row.id === "int_1")).toBe(true)

      await repos.filings.create({
        id: "pkg_1",
        firmId: "firmA",
        matterId: "mat_1",
        draftId: "drf_1",
        classification: "internal",
        citationStatus: "OK",
        temporalAllOk: true,
        status: "pending_partner_approval",
        createdBy: "associate_a",
        createdAt: 3,
        approvedBy: null,
        approvalReason: null,
      })
      const filing = await repos.filings.get("pkg_1")
      expect(filing?.status).toBe("pending_partner_approval")
      const filings = await repos.filings.listByFirm("firmA")
      expect(filings.some((row) => row.id === "pkg_1")).toBe(true)
    })
  })
})
