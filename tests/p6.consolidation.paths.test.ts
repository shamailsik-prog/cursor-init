/**
 * L16.3 — one learning path, one review path, one client path.
 * Off unless SIKANDER_FLAG_P6_CONSOLIDATION=true (unset means off).
 * None of these paths write the master. Learning proposes; user memory stays outside it.
 * platform/p6/learning/** is reserved for L4.6 and is not created here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { InMemoryMasterStore } from "@/platform/p6/masterStore"
import { masterWriteAuditLog } from "@/platform/p6/masterWrite"
import { isP6ConsolidationEnabled, P6_CONSOLIDATION_FLAG } from "@/platform/p6/consolidationFlag"
import {
  clientPathCalls,
  pushClientUpdate,
  reportToClient,
  runClientPath,
  whatsAppSelfService,
} from "@/platform/p6/clientPath"
import {
  learnContinuous,
  learnFirmData,
  learnMasterAutoUpdate,
  learnStyle,
  learnUserMemory,
  learningPathCalls,
  runLearningPath,
} from "@/platform/p6/learningPath"
import { reviewDraft, reviewPathCalls, runReviewPath, strategiseArgument, suggestForDraft } from "@/platform/p6/reviewPath"

const FLAG = `SIKANDER_FLAG_${P6_CONSOLIDATION_FLAG}`

function proposalInput(entryKey: string) {
  return {
    firmId: "firmA",
    proposedBy: "learner-1",
    classification: "confidential" as const,
    entryKey,
    payload: { wording: `text for ${entryKey}` },
  }
}

function walkTs(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      walkTs(path, out)
      continue
    }
    if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path)
  }
}

describe("P6 consolidation — one path each", () => {
  afterEach(() => {
    delete process.env[FLAG]
  })

  it("an unset flag is off and every deprecated entry refuses without a proposal or a master write", async () => {
    expect(isP6ConsolidationEnabled()).toBe(false)
    expect(process.env[FLAG]).toBeUndefined()
    const memory = new InMemoryMasterStore({ role: "p6_service" })
    const learningBefore = learningPathCalls()
    const reviewBefore = reviewPathCalls()
    const clientBefore = clientPathCalls()
    const auditBefore = masterWriteAuditLog().length
    await expect(learnStyle(proposalInput("clause.style"))).rejects.toThrow(/p6 consolidation paths are off/)
    await expect(learnFirmData(proposalInput("clause.firm"))).rejects.toThrow(/p6 consolidation paths are off/)
    await expect(learnContinuous(proposalInput("clause.continuous"))).rejects.toThrow(/p6 consolidation paths are off/)
    await expect(learnUserMemory(proposalInput("memory.user"))).rejects.toThrow(/p6 consolidation paths are off/)
    await expect(learnMasterAutoUpdate(proposalInput("clause.auto"))).rejects.toThrow(/p6 consolidation paths are off/)
    await expect(runLearningPath({ ...proposalInput("clause.direct"), mode: "style" })).rejects.toThrow(/p6 consolidation paths are off/)
    expect(() => suggestForDraft({ draftId: "d1", text: "grounds" })).toThrow(/p6 consolidation paths are off/)
    expect(() => reviewDraft({ draftId: "d1", text: "grounds" })).toThrow(/p6 consolidation paths are off/)
    expect(() => strategiseArgument({ draftId: "d1", text: "grounds" })).toThrow(/p6 consolidation paths are off/)
    expect(() => runReviewPath({ draftId: "d1", text: "grounds", mode: "draft-review" })).toThrow(/p6 consolidation paths are off/)
    expect(() => reportToClient({ firmId: "firmA", matterId: "m1" })).toThrow(/p6 consolidation paths are off/)
    expect(() => whatsAppSelfService({ firmId: "firmA", matterId: "m1" })).toThrow(/p6 consolidation paths are off/)
    expect(() => pushClientUpdate({ firmId: "firmA", matterId: "m1" })).toThrow(/p6 consolidation paths are off/)
    expect(() => runClientPath({ firmId: "firmA", matterId: "m1", mode: "update" })).toThrow(/p6 consolidation paths are off/)
    expect(learningPathCalls()).toBe(learningBefore)
    expect(reviewPathCalls()).toBe(reviewBefore)
    expect(clientPathCalls()).toBe(clientBefore)
    expect(masterWriteAuditLog().length).toBe(auditBefore)
    expect(await memory.listVersions("firmA")).toEqual([])
  })

  it("a value other than true stays off", () => {
    process.env[FLAG] = "1"
    expect(isP6ConsolidationEnabled()).toBe(false)
    process.env[FLAG] = "false"
    expect(isP6ConsolidationEnabled()).toBe(false)
  })

  it("each old learning entry routes through the one learning path and does not write the master", async () => {
    process.env[FLAG] = "true"
    const memory = new InMemoryMasterStore({ role: "p6_service" })
    const callsBefore = learningPathCalls()
    const auditBefore = masterWriteAuditLog().length
    const style = await learnStyle(proposalInput("clause.style"), memory)
    const firm = await learnFirmData(proposalInput("clause.firm"), memory)
    const continuous = await learnContinuous(proposalInput("clause.continuous"), memory)
    const memoryRow = await learnUserMemory(proposalInput("memory.user"), memory)
    const auto = await learnMasterAutoUpdate(proposalInput("clause.auto"), memory)
    expect(learningPathCalls() - callsBefore).toBe(5)
    expect(style).toMatchObject({ owner: "learning", mode: "style", sourceModule: "15", masterWrite: false, status: "pending" })
    expect(firm).toMatchObject({ owner: "learning", mode: "firm-data", sourceModule: "L3.2", masterWrite: false, status: "pending" })
    expect(continuous).toMatchObject({ owner: "learning", mode: "continuous", sourceModule: "L4.6", masterWrite: false, status: "pending" })
    expect(auto).toMatchObject({
      owner: "learning",
      mode: "master-auto-update",
      sourceModule: "L14.2",
      masterWrite: false,
      status: "pending",
    })
    expect(memoryRow).toEqual({ owner: "learning", mode: "user-memory", sourceModule: "L14.1", proposalId: null, masterWrite: false })
    expect(await memory.listVersions("firmA")).toEqual([])
    expect(masterWriteAuditLog().length).toBe(auditBefore)
    const stored = await Promise.all(
      [style, firm, continuous, auto].map((row) => memory.getProposal(row.proposalId!).then((saved) => saved?.sourceModule)),
    )
    expect(stored).toEqual(["15", "L3.2", "L4.6", "L14.2"])
    expect(await memory.getProposal("memory.user")).toBeNull()
    expect(existsSync("platform/p6/learning")).toBe(false)
  })

  it("each old review entry routes through the one advisor pass", () => {
    process.env[FLAG] = " true "
    const before = reviewPathCalls()
    const panel = suggestForDraft({ draftId: "d1", text: "grounds" })
    const reviewer = reviewDraft({ draftId: "d1", text: "grounds" })
    const strategist = strategiseArgument({ draftId: "d1", text: "grounds" })
    expect(reviewPathCalls() - before).toBe(3)
    expect(panel).toMatchObject({ owner: "review", mode: "suggestions", pass: "advisor", composed: true, draftId: "d1" })
    expect(reviewer).toMatchObject({ owner: "review", mode: "draft-review", pass: "advisor", composed: true })
    expect(strategist).toMatchObject({ owner: "review", mode: "argument", pass: "advisor", composed: true })
    expect(new Set([panel.pass, reviewer.pass, strategist.pass])).toEqual(new Set(["advisor"]))
  })

  it("each old client entry routes through the one client channel and does not send", () => {
    process.env[FLAG] = "TRUE"
    const before = clientPathCalls()
    const report = reportToClient({ firmId: "firmA", matterId: "m1" })
    const whatsapp = whatsAppSelfService({ firmId: "firmA", matterId: "m1" })
    const update = pushClientUpdate({ firmId: "firmA", matterId: "m1" })
    expect(clientPathCalls() - before).toBe(3)
    expect(report).toMatchObject({ owner: "client", mode: "reporting", channel: "client-channel", sent: false })
    expect(whatsapp).toMatchObject({ owner: "client", mode: "whatsapp", channel: "client-channel", sent: false })
    expect(update).toMatchObject({ owner: "client", mode: "update", channel: "client-channel", sent: false })
  })

  it("canonical modules do not import legacy governance, and the shims delegate", () => {
    const files: string[] = []
    walkTs("platform/p6", files)
    expect(files.some((path) => path.split("/").includes("learning"))).toBe(false)
    for (const path of files) {
      const source = readFileSync(path, "utf8")
      expect(source).not.toMatch(/workflowOps/)
      expect(source).not.toMatch(/ops-reporting/)
      expect(source).not.toMatch(/d4\/filings/)
      expect(source).not.toMatch(/denyByDefaultWorkflowOpsRepository/)
      expect(source).not.toMatch(/app\/ops\//)
    }
    const learning = readFileSync("platform/p6/learningPath.ts", "utf8")
    const review = readFileSync("platform/p6/reviewPath.ts", "utf8")
    const client = readFileSync("platform/p6/clientPath.ts", "utf8")
    expect(learning.match(/export async function runLearningPath/g)).toHaveLength(1)
    expect(review.match(/export function runReviewPath/g)).toHaveLength(1)
    expect(client.match(/export function runClientPath/g)).toHaveLength(1)
    for (const name of ["learnStyle", "learnFirmData", "learnContinuous", "learnUserMemory", "learnMasterAutoUpdate"]) {
      expect(learning).toMatch(new RegExp(`function ${name}[\\s\\S]*?runLearningPath\\(`))
    }
    for (const name of ["suggestForDraft", "reviewDraft", "strategiseArgument"]) {
      expect(review).toMatch(new RegExp(`function ${name}[\\s\\S]*?runReviewPath\\(`))
    }
    for (const name of ["reportToClient", "whatsAppSelfService", "pushClientUpdate"]) {
      expect(client).toMatch(new RegExp(`function ${name}[\\s\\S]*?runClientPath\\(`))
    }
  })
})
