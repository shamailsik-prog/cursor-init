/**
 * L4.6 continuous learning governance.
 * Learners propose. A partner decision is the only status change.
 * Nothing in platform/p6/learning writes the master. The sealed P6 path does that,
 * and only after this module has recorded a partner approval.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { InMemoryMasterStore, type MasterSession, type MasterStore } from "@/platform/p6/masterStore"
import { applyChange } from "@/platform/p6/proposeChange"
import { masterWriteAuditLog, scanP6MasterWriters } from "@/platform/p6/masterWrite"
import * as learning from "@/platform/p6/learning"
import {
  AUTHORISED_LEARNING_SOURCES,
  InMemoryLearningLedger,
  LEARNING_LIMITS,
  P6_LEARNING_FLAG,
  decideLearning,
  isP6LearningEnabled,
  proposeLearning,
  refuseDirectMasterWrite,
  type LearningActor,
  type LearningDeps,
  type ProposeLearningInput,
} from "@/platform/p6/learning"

const FLAG = `SIKANDER_FLAG_${P6_LEARNING_FLAG}`
const OPEN = { g3Passed: true, learnersFlag: true }

const WRITER_PATTERNS = [
  /\bwriteMaster\s*\(/,
  /\bapplyChange\s*\(/,
  /\brollbackMaster\s*\(/,
  /\.commitVersion\s*\(/,
  /\.persistVersion\s*\(/,
  /\bsessionForWrite\s*\(/,
  /\bsealMasterSession\s*\(/,
  /\bexecuteMasterTableWrite\s*\(/,
  /\bINSERT\s+INTO\s+(?:ONLY\s+)?["']?master_/i,
  /\bUPDATE\s+(?:ONLY\s+)?["']?master_/i,
  /\bDELETE\s+FROM\s+(?:ONLY\s+)?["']?master_/i,
  /collection\(\s*['"]master/i,
]

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      walk(path, out)
      continue
    }
    if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path)
  }
}

function watching(inner: MasterStore): { store: MasterStore; commits: () => number; inserts: () => number } {
  let commits = 0
  let inserts = 0
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      if (prop === "insertProposal") {
        return (...args: unknown[]) => {
          inserts += 1
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      if (prop === "commitVersion") {
        return (...args: unknown[]) => {
          commits += 1
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      if (prop === "runExclusive") {
        return (fn: (tx: MasterSession) => Promise<unknown>) =>
          (value as (fn: (tx: MasterSession) => Promise<unknown>) => Promise<unknown>).call(target, async (tx) => {
            const wrapped = new Proxy(tx, {
              get(session, key, sessionReceiver) {
                const method: unknown = Reflect.get(session, key, sessionReceiver)
                if (key === "commitVersion" && typeof method === "function") {
                  return (...args: unknown[]) => {
                    commits += 1
                    return (method as (...a: unknown[]) => unknown).apply(session, args)
                  }
                }
                return typeof method === "function" ? method.bind(session) : method
              },
            })
            return fn(wrapped)
          })
      }
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  }) as MasterStore
  return { store, commits: () => commits, inserts: () => inserts }
}

function proposal(over: Partial<ProposeLearningInput> = {}): ProposeLearningInput {
  return {
    firmId: "firmA",
    proposedBy: "learner-1",
    source: "accepted-draft",
    evidence: "draft-100 accepted by the partner desk",
    entryKey: "clause.notice",
    classification: "confidential",
    before: { clause: "the plaintiff" },
    after: { clause: "the defendant" },
    ...over,
  }
}

function partner(over: Partial<LearningActor> = {}): LearningActor {
  return {
    actorId: "partner_b",
    firmId: "firmA",
    kind: "partner",
    role: "partner",
    decision: "approved",
    ...over,
  }
}

function storeHolding(bodies: Record<string, unknown>): MasterStore {
  const inner = new InMemoryMasterStore({ role: "p6_service" })
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "currentSnapshot") {
        return async () => ({
          entries: Object.fromEntries(
            Object.entries(bodies).map(([key, body]) => [
              key,
              { partition: "mutable" as const, key, body, classification: "confidential" },
            ]),
          ),
        })
      }
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as MasterStore
}

function harness(over: Partial<LearningDeps> = {}): {
  deps: LearningDeps
  store: MasterStore
  commits: () => number
  inserts: () => number
  ledger: InMemoryLearningLedger
} {
  const ledger = new InMemoryLearningLedger()
  const watched = watching(new InMemoryMasterStore({ role: "p6_service" }))
  const deps: LearningDeps = {
    ledger,
    posture: OPEN,
    store: watched.store,
    env: { [FLAG]: "true" },
    now: () => new Date("2026-11-24T00:00:00.000Z"),
    ...over,
  }
  return { deps, store: watched.store, commits: watched.commits, inserts: watched.inserts, ledger }
}

describe("L4.6 learning governance", () => {
  afterEach(() => {
    delete process.env[FLAG]
  })

  it("is off unless the local flag is exactly true", () => {
    expect(isP6LearningEnabled({})).toBe(false)
    expect(isP6LearningEnabled({ [FLAG]: "1" })).toBe(false)
    expect(isP6LearningEnabled({ [FLAG]: "yes" })).toBe(false)
    expect(isP6LearningEnabled({ [FLAG]: "false" })).toBe(false)
    expect(isP6LearningEnabled({ [FLAG]: " true " })).toBe(true)
    expect(isP6LearningEnabled({ [FLAG]: "TRUE" })).toBe(true)
    expect(P6_LEARNING_FLAG).toBe("P6_LEARNING")
    expect(LEARNING_LIMITS.maxProposalsPerWindow).toBeGreaterThan(0)
  })

  it("refuses every proposal while the flag is off, and does not touch the master", async () => {
    const { deps, commits, inserts, ledger } = harness({ env: {} })
    const auditBefore = masterWriteAuditLog().length
    await expect(proposeLearning(proposal(), deps)).rejects.toThrow(/learning governance is off/)
    expect(await ledger.get("missing")).toBeNull()
    expect(commits()).toBe(0)
    expect(inserts()).toBe(0)
    expect(masterWriteAuditLog().length).toBe(auditBefore)
    expect(await deps.store!.listVersions("firmA")).toEqual([])
  })

  it("stays off when G-3 has not passed, even with the flag on", async () => {
    const closed = harness({ posture: { g3Passed: false, learnersFlag: true } })
    await expect(proposeLearning(proposal(), closed.deps)).rejects.toThrow(/learners remain off until G3 passes/)
    const learnersOff = harness({ posture: { g3Passed: true, learnersFlag: false } })
    await expect(proposeLearning(proposal(), learnersOff.deps)).rejects.toThrow(/learners remain off until G3 passes/)
    const notBoolean = harness({ posture: { g3Passed: 1 as unknown as boolean, learnersFlag: true } })
    await expect(proposeLearning(proposal(), notBoolean.deps)).rejects.toThrow(/learners remain off until G3 passes/)
    expect(closed.inserts()).toBe(0)
  })

  it("stores a pending durable proposal and does not write the master", async () => {
    const { deps, commits, inserts, ledger } = harness()
    const auditBefore = masterWriteAuditLog().length
    const row = await proposeLearning(proposal(), deps)
    expect(row).toMatchObject({
      firmId: "firmA",
      proposedBy: "learner-1",
      source: "accepted-draft",
      evidence: "draft-100 accepted by the partner desk",
      entryKey: "clause.notice",
      classification: "confidential",
      changeClass: "substantive",
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      sealedProposalId: null,
      masterWrite: false,
      createdAt: "2026-11-24T00:00:00.000Z",
      diff: { before: { clause: "the plaintiff" }, after: { clause: "the defendant" } },
    })
    expect(row.id).toMatch(/[0-9a-f-]{36}/)
    expect((await ledger.get(row.id))?.status).toBe("pending")
    expect(commits()).toBe(0)
    expect(inserts()).toBe(0)
    expect(masterWriteAuditLog().length).toBe(auditBefore)
    expect(await deps.store!.listVersions("firmA")).toEqual([])
  })

  it("reuses the p6 classifier and fails closed when the class is in doubt", async () => {
    const ledger = new InMemoryLearningLedger()
    const deps: LearningDeps = {
      ledger,
      posture: OPEN,
      store: storeHolding({
        "clause.space": { clause: "the  plaintiff" },
        "clause.order": { b: 1, a: 2 },
        "clause.proto": { clause: "x" },
        "clause.smuggle": { clause: "the plaintiff" },
      }),
      env: { [FLAG]: "true" },
      now: () => new Date("2026-11-24T00:00:00.000Z"),
    }
    const cosmeticSpace = await proposeLearning(
      proposal({
        entryKey: "clause.space",
        before: { clause: "the  plaintiff" },
        after: { clause: "the plaintiff" },
      }),
      deps,
    )
    const cosmeticOrder = await proposeLearning(
      proposal({
        entryKey: "clause.order",
        before: { b: 1, a: 2 },
        after: { a: 2, b: 1 },
      }),
      deps,
    )
    const missingBefore = await proposeLearning(
      proposal({ entryKey: "clause.new", before: undefined, after: { clause: "fresh" } }),
      deps,
    )
    const polluted = Object.create(null) as Record<string, unknown>
    Object.defineProperty(polluted, "__proto__", {
      value: { admin: true },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(polluted, "clause", { value: "x", enumerable: true, writable: true, configurable: true })
    const substantiveDoubt = await proposeLearning(
      proposal({ entryKey: "clause.proto", before: { clause: "x" }, after: polluted }),
      deps,
    )
    const smuggled = await proposeLearning(
      { ...proposal({ entryKey: "clause.smuggle" }), changeClass: "cosmetic" } as ProposeLearningInput,
      deps,
    )
    const { deps: empty } = harness()
    const unconfirmed = await proposeLearning(
      proposal({
        entryKey: "clause.unconfirmed",
        before: { clause: "the  plaintiff" },
        after: { clause: "the plaintiff" },
      }),
      empty,
    )
    expect(cosmeticSpace.changeClass).toBe("cosmetic")
    expect(cosmeticOrder.changeClass).toBe("cosmetic")
    expect(missingBefore.changeClass).toBe("substantive")
    expect(substantiveDoubt.changeClass).toBe("substantive")
    expect(smuggled.changeClass).toBe("substantive")
    expect(smuggled.status).toBe("pending")
    expect(unconfirmed.changeClass).toBe("substantive")
  })

  it("rejects a smuggled approved status and a mutated return value", async () => {
    const { deps, ledger } = harness()
    const row = await proposeLearning({ ...proposal(), status: "approved" } as ProposeLearningInput, deps)
    expect(row.status).toBe("pending")
    row.status = "approved"
    expect((await ledger.get(row.id))?.status).toBe("pending")
  })

  it("rejects proposals from sources that are not authorised", async () => {
    const { deps, ledger, inserts } = harness()
    for (const source of ["model", "autonomous", "internet", "master", "accepted-drafts", ""]) {
      await expect(proposeLearning(proposal({ source }), deps)).rejects.toThrow(/learning source is not authorised/)
    }
    expect(inserts()).toBe(0)
    await expect(proposeLearning(proposal({ evidence: "   " }), deps)).rejects.toThrow(/learning proposal omitted evidence/)
    await expect(proposeLearning(proposal({ firmId: " " }), deps)).rejects.toThrow(/omitted firm, author or entry/)
    await expect(proposeLearning(proposal({ proposedBy: " " }), deps)).rejects.toThrow(/omitted firm, author or entry/)
    await expect(proposeLearning(proposal({ entryKey: "" }), deps)).rejects.toThrow(/omitted firm, author or entry/)
    await expect(proposeLearning(proposal({ classification: "secret" as "confidential" }), deps)).rejects.toThrow(
      /artefact write omitted classification/,
    )
    expect(await ledger.findByFingerprint("none")).toBeNull()
  })

  it("refuses the immutable citation partition", async () => {
    const { deps, inserts } = harness()
    await expect(proposeLearning(proposal({ entryKey: "citation_protocol" }), deps)).rejects.toThrow(
      /immutable master partition is not writable/,
    )
    await expect(proposeLearning(proposal({ entryKey: "verification_protocol" }), deps)).rejects.toThrow(
      /immutable master partition is not writable/,
    )
    await expect(proposeLearning(proposal({ partition: "immutable" }), deps)).rejects.toThrow(
      /immutable master partition is not writable/,
    )
    expect(inserts()).toBe(0)
  })

  it("dedupes an identical proposal, including key order, and does not spend the rate limit on the duplicate", async () => {
    const { deps } = harness({ limits: { maxProposalsPerWindow: 1, windowMs: 60_000 } })
    const first = await proposeLearning(proposal({ before: { b: 1, a: 2 }, after: { a: 2, b: 1 } }), deps)
    const again = await proposeLearning(
      proposal({
        before: { a: 2, b: 1 },
        after: { b: 1, a: 2 },
        evidence: "a second draft of the same change",
        proposedBy: "learner-2",
      }),
      deps,
    )
    expect(again.id).toBe(first.id)
    await expect(
      proposeLearning(proposal({ entryKey: "clause.other", after: { clause: "other" } }), deps),
    ).rejects.toThrow(/learning proposal rate limited/)
  })

  it("caps proposal size and rate, then accepts again once the window moves", async () => {
    let now = new Date("2026-11-24T00:00:00.000Z")
    const { deps, ledger } = harness({
      now: () => now,
      limits: { maxProposalsPerWindow: 2, windowMs: 1_000, maxPayloadBytes: 400 },
    })
    await expect(proposeLearning(proposal({ after: { clause: "x".repeat(500) } }), deps)).rejects.toThrow(
      /learning proposal exceeds size cap/,
    )
    const first = await proposeLearning(proposal({ entryKey: "clause.one" }), deps)
    const second = await proposeLearning(proposal({ entryKey: "clause.two" }), deps)
    await expect(proposeLearning(proposal({ entryKey: "clause.three" }), deps)).rejects.toThrow(/learning proposal rate limited/)
    expect(await ledger.get(first.id)).not.toBeNull()
    expect(await ledger.get(second.id)).not.toBeNull()
    now = new Date(now.getTime() + 1_000)
    const third = await proposeLearning(proposal({ entryKey: "clause.three" }), deps)
    expect(third.status).toBe("pending")
  })

  it("refuses a value that cannot be stored", async () => {
    const { deps } = harness()
    const circular: Record<string, unknown> = { clause: "loop" }
    circular.self = circular
    await expect(proposeLearning(proposal({ after: circular }), deps)).rejects.toThrow(/learning proposal is not durable/)
    await expect(proposeLearning(proposal({ after: { run: () => "no" } }), deps)).rejects.toThrow(
      /learning proposal is not durable/,
    )
  })

  it("moves pending to approved or rejected only for a different partner, and still does not write the master", async () => {
    const { deps, commits, inserts, ledger } = harness()
    const auditBefore = masterWriteAuditLog().length
    const pending = await proposeLearning(proposal(), deps)
    const approved = await decideLearning(pending.id, partner(), deps)
    expect(approved.status).toBe("approved")
    expect(approved.decidedBy).toBe("partner_b")
    expect(approved.decidedAt).toBe("2026-11-24T00:00:00.000Z")
    expect(approved.masterWrite).toBe(false)
    expect(approved.sealedProposalId).toEqual(expect.any(String))
    const sealed = await deps.store!.getProposal(approved.sealedProposalId!)
    expect(sealed?.status).toBe("approved")
    expect(sealed?.changeClass).toBe("substantive")
    expect(sealed?.decidedKind).toBe("partner")
    expect(commits()).toBe(0)
    expect(inserts()).toBe(1)
    expect(await deps.store!.listVersions("firmA")).toEqual([])
    expect(masterWriteAuditLog().length).toBe(auditBefore)
    expect((await ledger.get(pending.id))?.status).toBe("approved")

    const claimed = await proposeLearning(
      proposal({ entryKey: "clause.space", before: { clause: "the  plaintiff" }, after: { clause: "the plaintiff" } }),
      deps,
    )
    expect(claimed.changeClass).toBe("substantive")
    const claimedApproved = await decideLearning(claimed.id, partner(), deps)
    expect((await deps.store!.getProposal(claimedApproved.sealedProposalId!))?.changeClass).toBe("substantive")
    expect(commits()).toBe(0)
    expect(await deps.store!.listVersions("firmA")).toEqual([])

    const rejected = await proposeLearning(proposal({ entryKey: "clause.no" }), deps)
    const no = await decideLearning(rejected.id, partner({ decision: "rejected" }), deps)
    expect(no.status).toBe("rejected")
    expect(no.sealedProposalId).toBeNull()
    expect(commits()).toBe(0)
  })

  it("the sealed master path writes only when something outside learning applies a partner-approved proposal", async () => {
    const memory = new InMemoryMasterStore({ role: "p6_service" })
    const ledger = new InMemoryLearningLedger()
    const deps: LearningDeps = {
      ledger,
      posture: OPEN,
      store: memory,
      env: { [FLAG]: "true" },
      now: () => new Date("2026-11-24T00:00:00.000Z"),
    }
    const pending = await proposeLearning(proposal(), deps)
    expect(await memory.listVersions("firmA")).toEqual([])
    const approved = await decideLearning(pending.id, partner(), deps)
    expect(await memory.listVersions("firmA")).toEqual([])
    const applied = await applyChange(approved.sealedProposalId!, memory)
    expect(applied.masterWritten).toBe(true)
    expect(await memory.listVersions("firmA")).toHaveLength(1)
    expect((await ledger.get(pending.id))?.masterWrite).toBe(false)
  })

  it("refuses approval bypasses and leaves the proposal pending", async () => {
    const { deps, commits, inserts } = harness()
    const pending = await proposeLearning(proposal({ proposedBy: "Partner_B" }), deps)
    const attacks: Array<Partial<LearningActor>> = [
      { kind: "model" },
      { kind: "autonomous" },
      { kind: "system", role: "system" },
      { role: "associate" },
      { role: "clerk" },
      { role: "intern" },
      { actorId: "partner_b" },
      { firmId: "firmB" },
      { actorId: " " },
      { decision: "applied" as "approved" },
    ]
    for (const attack of attacks) {
      await expect(decideLearning(pending.id, partner(attack), deps)).rejects.toThrow()
    }
    expect((await deps.ledger.get(pending.id))?.status).toBe("pending")
    expect((await deps.ledger.get(pending.id))?.sealedProposalId).toBeNull()
    expect(commits()).toBe(0)
    expect(inserts()).toBe(0)
    await expect(decideLearning("missing", partner(), deps)).rejects.toThrow(/proposal not found/)
    const decided = await decideLearning(pending.id, partner({ actorId: "partner_c" }), deps)
    expect(decided.status).toBe("approved")
    await expect(decideLearning(pending.id, partner({ actorId: "partner_d", decision: "rejected" }), deps)).rejects.toThrow(
      /proposal is not pending/,
    )
    expect((await deps.ledger.get(pending.id))?.status).toBe("approved")
    expect(commits()).toBe(0)
  })

  it("a rejection does not open the sealed path, and the same change can be proposed again", async () => {
    const { deps, inserts } = harness()
    const pending = await proposeLearning(proposal(), deps)
    await decideLearning(pending.id, partner({ decision: "rejected" }), deps)
    expect(inserts()).toBe(0)
    const again = await proposeLearning(proposal(), deps)
    expect(again.id).not.toBe(pending.id)
    expect(again.status).toBe("pending")
  })

  it("the ledger itself refuses an approved insert and an applied transition", async () => {
    const ledger = new InMemoryLearningLedger()
    const forged = {
      id: "00000000-0000-4000-8000-000000000046",
      firmId: "firmA",
      proposedBy: "learner-1",
      source: "accepted-draft" as const,
      evidence: "forged",
      entryKey: "clause.notice",
      classification: "confidential" as const,
      changeClass: "substantive" as const,
      diff: { before: { clause: "a" }, after: { clause: "b" } },
      createdAt: "2026-11-24T00:00:00.000Z",
      status: "approved" as const,
      decidedBy: "partner_b",
      decidedAt: "2026-11-24T00:00:00.000Z",
      masterWrite: false as const,
      sealedProposalId: null,
    }
    await expect(ledger.insert(forged, "fp")).rejects.toThrow(/new proposals are pending/)
    expect(await ledger.get(forged.id)).toBeNull()
    const { deps } = harness()
    const pending = await proposeLearning(proposal(), deps)
    const applied = await deps.ledger.compareAndSetStatus(pending.id, "pending", {
      status: "applied" as unknown as "approved",
      decidedBy: "partner_b",
      decidedAt: "2026-11-24T00:00:00.000Z",
      sealedProposalId: null,
    })
    expect(applied).toBeNull()
    expect((await deps.ledger.get(pending.id))?.status).toBe("pending")
    const self = await deps.ledger.compareAndSetStatus(pending.id, "pending", {
      status: "approved",
      decidedBy: "learner-1",
      decidedAt: "2026-11-24T00:00:00.000Z",
      sealedProposalId: "should-not-stick",
    })
    expect(self).toBeNull()
    expect((await deps.ledger.get(pending.id))?.sealedProposalId).toBeNull()
  })

  it("a non-P6 store cannot be used to approve onto the sealed path", async () => {
    const ledger = new InMemoryLearningLedger()
    const store = new InMemoryMasterStore({ role: "app" })
    const deps: LearningDeps = {
      ledger,
      posture: OPEN,
      store,
      env: { [FLAG]: "true" },
      now: () => new Date("2026-11-24T00:00:00.000Z"),
    }
    const pending = await proposeLearning(proposal(), deps)
    await expect(decideLearning(pending.id, partner(), deps)).rejects.toThrow(/non-P6 writer refused/)
    expect((await ledger.get(pending.id))?.status).toBe("pending")
    expect(await store.listVersions("firmA")).toEqual([])
  })

  it("refuses a direct master write and exports no writer", () => {
    expect(() => refuseDirectMasterWrite()).toThrow(/learning cannot write the master/)
    for (const name of ["applyChange", "writeMaster", "rollbackMaster", "commitVersion", "sealMasterSession"]) {
      expect(learning).not.toHaveProperty(name)
    }
  })

  it("the learning tree is not a second master writer, and the CI scanner passes", () => {
    expect(scanP6MasterWriters()).toEqual([])
    const files: string[] = []
    walk("platform/p6/learning", files)
    expect(files.length).toBeGreaterThan(0)
    for (const path of files) {
      const source = readFileSync(path, "utf8")
      for (const pattern of WRITER_PATTERNS) {
        expect(source, path).not.toMatch(pattern)
      }
    }
    const output = execFileSync("python3", ["ci_gates/check_master_writes.py"], { encoding: "utf8" })
    expect(output).toMatch(/PASS: no master writes outside P6/)
  })

  it("accepts every authorised source and no others", async () => {
    const { deps } = harness()
    for (const source of AUTHORISED_LEARNING_SOURCES) {
      const row = await proposeLearning(proposal({ source, entryKey: `clause.${source}` }), deps)
      expect(row.source).toBe(source)
      expect(row.status).toBe("pending")
    }
  })
})
