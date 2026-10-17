import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthorityUnavailableError, InMemoryAuthorityStore, type AuthorityStore } from "../src/d4/authority"
import * as gate from "../src/d4/gate"

/**
 * Audit F17, spec ruling 2: the committee answer's citations are resolved through the D4 gate's own steps, never a
 * fork. These are the steps `checkCitations` is composed of, exported: `lookUpCitation` (what one extracted ref is, and
 * the gate's de-duplication key), `verdictOfJudgment` (the verdict rule over the store's treatments) and `budgetedStore`
 * (the run's authority budget, D24). The gate's own behaviour is held by test/d4.gate.test.ts, unchanged.
 *
 * Fixtures follow P4-13: the year 2099, no real judgment.
 */

type Lookup = { kind: string; ref: string; key: string; judgmentId?: string; benchType?: string }
type Verdict = { status: string; treatmentsUnavailable: boolean }
type Pieces = {
  lookUpCitation: (raw: string, store: AuthorityStore) => Promise<Lookup | null>
  verdictOfJudgment: (found: { judgmentId: string; benchType: string }, store: AuthorityStore) => Promise<Verdict>
  budgetedStore: (store: AuthorityStore, budgetMs: number, now: () => number) => AuthorityStore
}
const pieces = gate as unknown as Partial<Pieces>

function corpus(): InMemoryAuthorityStore {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j-good", "PLD 2099 SC 101", "division")
  s.addJudgment("j-old", "2099 SCMR 202", "division")
  s.addJudgment("j-larger", "PLD 2099 SC 303", "larger")
  s.addJudgment("j-pending", "2099 SCMR 404", "division")
  s.addTreatment("j-larger", "j-old", "overruled", "larger")
  s.addPendingOverruling("j-pending")
  return s
}

const unavailable: AuthorityStore = {
  async findJudgment() {
    throw new AuthorityUnavailableError("unreachable")
  },
  async listTreatments() {
    throw new AuthorityUnavailableError("unreachable")
  },
  async getSectionAsAt() {
    throw new AuthorityUnavailableError("unreachable")
  },
}

afterEach(() => {
  vi.useRealTimers()
})

describe("audit F17: the D4 gate's citation steps, exported for reuse (spec ruling 2)", () => {
  it("exports lookUpCitation, verdictOfJudgment and budgetedStore", () => {
    expect(typeof pieces.lookUpCitation).toBe("function")
    expect(typeof pieces.verdictOfJudgment).toBe("function")
    expect(typeof pieces.budgetedStore).toBe("function")
  })

  it("lookUpCitation: a found judgment, keyed by its id; an absent one, keyed by its canonical ref", async () => {
    const store = corpus()
    expect(await pieces.lookUpCitation!("PLD 2099 Supreme Court 101", store)).toEqual({
      kind: "found",
      ref: "PLD 2099 SC 101",
      key: "j:j-good",
      judgmentId: "j-good",
      benchType: "division",
    })
    expect(await pieces.lookUpCitation!("PLD 2099 SC 7777", store)).toEqual({ kind: "not_found", ref: "PLD 2099 SC 7777", key: "r:PLD 2099 SC 7777" })
  })

  it("lookUpCitation: a suspect is never looked up; a ref that does not normalise is never looked up; a blank is null", async () => {
    const calls: string[] = []
    const store: AuthorityStore = { findJudgment: async (c) => (calls.push(c), null), listTreatments: async () => [], getSectionAsAt: async () => "no_history" }
    expect(await pieces.lookUpCitation!("UNRECOGNISED: 2099SCMR456", store)).toEqual({ kind: "unrecognised", ref: "UNRECOGNISED: 2099SCMR456", key: "r:UNRECOGNISED: 2099SCMR456" })
    expect(await pieces.lookUpCitation!("Section 5, Test Act 2099", store)).toEqual({ kind: "not_normalised", ref: "Section 5, Test Act 2099", key: "r:Section 5, Test Act 2099" })
    expect(await pieces.lookUpCitation!("   ", store)).toBeNull()
    expect(calls).toEqual([])
  })

  it("lookUpCitation: a store that cannot answer is `unavailable`, never not found", async () => {
    expect(await pieces.lookUpCitation!("PLD 2099 SC 101", unavailable)).toEqual({ kind: "unavailable", ref: "PLD 2099 SC 101", key: "r:PLD 2099 SC 101" })
  })

  it("lookUpCitation: any other store error is a bug and propagates", async () => {
    const broken: AuthorityStore = { ...unavailable, findJudgment: async () => Promise.reject(new Error("bug")) }
    await expect(pieces.lookUpCitation!("PLD 2099 SC 101", broken)).rejects.toThrow("bug")
  })

  it("verdictOfJudgment: the verdict rule over the store's treatments", async () => {
    const store = corpus()
    expect(await pieces.verdictOfJudgment!({ judgmentId: "j-good", benchType: "division" }, store)).toEqual({ status: "VERIFIED", treatmentsUnavailable: false })
    expect(await pieces.verdictOfJudgment!({ judgmentId: "j-old", benchType: "division" }, store)).toEqual({ status: "OVERRULED", treatmentsUnavailable: false })
    expect(await pieces.verdictOfJudgment!({ judgmentId: "j-pending", benchType: "division" }, store)).toEqual({ status: "UNVERIFIED", treatmentsUnavailable: false })
    expect(await pieces.verdictOfJudgment!({ judgmentId: "j-good", benchType: "division" }, unavailable)).toEqual({ status: "UNVERIFIED", treatmentsUnavailable: true })
  })

  it("budgetedStore: once the budget is spent every call is unavailable (reason budget)", async () => {
    let t = 0
    const slow: AuthorityStore = {
      async findJudgment() {
        t += 50
        return null
      },
      listTreatments: async () => [],
      getSectionAsAt: async () => "no_history",
    }
    const store = pieces.budgetedStore!(slow, 60, () => t)
    expect(await store.findJudgment("PLD 2099 SC 1")).toBeNull()
    expect(await store.findJudgment("PLD 2099 SC 2")).toBeNull()
    const err = await store.findJudgment("PLD 2099 SC 3").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthorityUnavailableError)
    expect((err as AuthorityUnavailableError).reason).toBe("budget")
  })
})
