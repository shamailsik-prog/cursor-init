import { normalizeActorKey } from "@/platform/p6/masterStore"
import type { LearningProposalRecord } from "@/platform/p6/learning/types"

export type LearningStatusPatch = {
  status: "approved" | "rejected"
  decidedBy: string
  decidedAt: string
  sealedProposalId: string | null
}

export interface LearningLedger {
  get(id: string): Promise<LearningProposalRecord | null>
  findByFingerprint(fingerprint: string): Promise<LearningProposalRecord | null>
  insert(row: LearningProposalRecord, fingerprint: string): Promise<LearningProposalRecord>
  /**
   * pending → approved or rejected, and only for a different actor.
   * Any other status, including a direct apply, returns null and changes nothing.
   */
  compareAndSetStatus(id: string, from: "pending", next: LearningStatusPatch): Promise<LearningProposalRecord | null>
  consumeRate(key: string, nowMs: number, max: number, windowMs: number): Promise<boolean>
}

function clone(row: LearningProposalRecord): LearningProposalRecord {
  return structuredClone(row)
}

export class InMemoryLearningLedger implements LearningLedger {
  private readonly rows = new Map<string, LearningProposalRecord>()
  private readonly byFingerprint = new Map<string, string>()
  private readonly hits = new Map<string, number[]>()

  async get(id: string): Promise<LearningProposalRecord | null> {
    const row = this.rows.get(id)
    return row ? clone(row) : null
  }

  async findByFingerprint(fingerprint: string): Promise<LearningProposalRecord | null> {
    const id = this.byFingerprint.get(fingerprint)
    if (!id) return null
    return this.get(id)
  }

  async insert(row: LearningProposalRecord, fingerprint: string): Promise<LearningProposalRecord> {
    if (
      row.status !== "pending" ||
      row.decidedBy !== null ||
      row.decidedAt !== null ||
      row.sealedProposalId !== null ||
      row.masterWrite !== false ||
      this.rows.has(row.id)
    ) {
      throw new Error("new proposals are pending")
    }
    const stored = clone(row)
    this.rows.set(row.id, stored)
    this.byFingerprint.set(fingerprint, row.id)
    return clone(stored)
  }

  async compareAndSetStatus(
    id: string,
    from: "pending",
    next: LearningStatusPatch,
  ): Promise<LearningProposalRecord | null> {
    const current = this.rows.get(id)
    if (!current || current.status !== from) return null
    const status = (next as { status: string }).status
    if (status !== "approved" && status !== "rejected") return null
    const actor = normalizeActorKey(next.decidedBy)
    if (actor === "" || actor === normalizeActorKey(current.proposedBy)) return null
    if (status === "rejected" && next.sealedProposalId !== null) return null
    const stored: LearningProposalRecord = {
      ...current,
      status,
      decidedBy: next.decidedBy,
      decidedAt: next.decidedAt,
      sealedProposalId: status === "approved" ? next.sealedProposalId : null,
      masterWrite: false,
    }
    this.rows.set(id, stored)
    if (status === "rejected") {
      for (const [fingerprint, rowId] of this.byFingerprint) {
        if (rowId === id) this.byFingerprint.delete(fingerprint)
      }
    }
    return clone(stored)
  }

  async consumeRate(key: string, nowMs: number, max: number, windowMs: number): Promise<boolean> {
    const prev = (this.hits.get(key) ?? []).filter((at) => nowMs - at < windowMs)
    if (prev.length >= max) {
      this.hits.set(key, prev)
      return false
    }
    prev.push(nowMs)
    this.hits.set(key, prev)
    return true
  }
}
