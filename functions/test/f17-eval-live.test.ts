import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SYSTEM_POLICIES } from "@/platform/p1/systemPolicy"
import { TASK_MODEL } from "../src/p1/costTable"
import { P1TransportError, type P1Transport } from "../src/p1/transport"

/**
 * Audit F17, spec ruling 5: the live evaluation harness (`npm --prefix functions run eval:committee-live`). It runs the
 * set's prompts against the real model only when AI_GATEWAY_API_KEY is set; otherwise it reports NOT RUN, sends
 * nothing and exits 0 (never a pass). With a key it sends each prompt with the registry's committee-brain system
 * message to the configured model, grades the masked answer against the set's corpus and checks the item's live
 * expectations. Here the transport is a stub: no model is called in this environment.
 */

const SET = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "docs", "evals", "committee-brain-eval-set.json"), "utf8")) as {
  items: Array<{ id: string; prompt: string; response: string }>
}

type Deps = { env: Record<string, string | undefined>; out: (line: string) => void; readSet: () => unknown; transportFor: (key: string) => P1Transport }
type Cli = { runCommitteeEval: (deps: Deps) => Promise<number> }
const load = async (): Promise<Cli> => (await import("../src/cli/committeeEval")) as unknown as Cli

const GROUNDED = JSON.stringify({
  sections: [{ heading: "Answer", text: "", claims: [{ statement: "Bail is the rule where further inquiry is needed.", authorities: [{ kind: "judgment", citation: "PLD 2099 SC 101" }] }] }],
  caveats: [],
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("audit F17: the live evaluation harness (spec ruling 5)", () => {
  it("without AI_GATEWAY_API_KEY: reports NOT RUN, sends nothing, exits 0", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const lines: string[] = []
    const transportFor = vi.fn()
    const code = await (await load()).runCommitteeEval({ env: { AI_GATEWAY_API_KEY: "  " }, out: (l) => lines.push(l), readSet: () => SET, transportFor })
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(new RegExp(`^NOT RUN: AI_GATEWAY_API_KEY is not set; the live evaluation of the ${SET.items.length} items of eval set f17\\.3 did not run`))
    expect(transportFor).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("with a key: every prompt goes to the configured model with the committee-brain system message; a well-behaved model passes", async () => {
    const sent: Array<{ model: string; messages: Array<{ role: string; content: string }>; maxTokens: number }> = []
    const lines: string[] = []
    const transport: P1Transport = {
      async send(r) {
        sent.push(r)
        return { text: GROUNDED, inputTokens: 10, outputTokens: 10, model: "claude-opus-5.5" }
      },
    }
    const code = await (await load()).runCommitteeEval({ env: { AI_GATEWAY_API_KEY: "test-key" }, out: (l) => lines.push(l), readSet: () => SET, transportFor: () => transport })
    expect(code).toBe(0)
    expect(sent).toHaveLength(SET.items.length)
    for (const r of sent) {
      expect(r.model).toBe(TASK_MODEL.committee)
      expect(r.maxTokens).toBe(4096)
      expect(r.messages[0]).toEqual({ role: "system", content: SYSTEM_POLICIES["committee-brain"].text })
      expect(r.messages[1]!.role).toBe("user")
    }
    expect(sent[0]!.messages[1]!.content).toBe(SET.items[0]!.prompt)
    expect(lines[0]).toMatch(/^LIVE: \d+ items of eval set f17\.3 against /)
    expect(lines[0]).toMatch(/worst case \d+ micro-USD/)
    expect(lines.at(-1)).toBe(`PASS: ${SET.items.length} passed, 0 failed`)
    const report = JSON.parse(lines[1]!) as { items: Array<{ modelReported: string | null }> }
    expect(report.items.every((i) => i.modelReported === "claude-opus-5.5")).toBe(true)
  })

  it("with a key: a model that answers like the recorded responses fails the items it should, and the harness exits 1", async () => {
    const lines: string[] = []
    // Items are sent one at a time, in order (some prompts repeat, so the answer follows the order, not the prompt).
    let next = 0
    const transport: P1Transport = {
      async send() {
        return { text: SET.items[next++]!.response, inputTokens: 10, outputTokens: 10 }
      },
    }
    const code = await (await load()).runCommitteeEval({ env: { AI_GATEWAY_API_KEY: "test-key" }, out: (l) => lines.push(l), readSet: () => SET, transportFor: () => transport })
    expect(code).toBe(1)
    const report = JSON.parse(lines[1]!) as { failed: number; items: Array<{ id: string; pass: boolean; problems: string[] }> }
    const of = (id: string) => report.items.find((i) => i.id === id)!
    expect(of("en-grd-01")).toMatchObject({ pass: true, problems: [] })
    expect(of("en-fab-01").problems).toEqual(["relied_on:PLD 2099 SC 7777"])
    expect(of("en-uns-01").problems).toEqual(["not_structured"])
    expect(of("en-inj-02").problems).toEqual(["relied_on:PLD 2099 SC 7777", "claims_verification"])
    expect(of("ur-inj-01").problems).toEqual(["relied_on:PLD 2099 SC 7777", "claims_verification"])
    expect(report.failed).toBeGreaterThan(0)
    expect(lines.at(-1)).toMatch(/^FAIL: \d+ passed, \d+ failed$/)
  })

  it("with a key: a transport failure fails that item by its code, never with provider text", async () => {
    const lines: string[] = []
    const transport: P1Transport = {
      async send() {
        throw new P1TransportError("gateway_status", { billable: false, status: 503 })
      },
    }
    const code = await (await load()).runCommitteeEval({ env: { AI_GATEWAY_API_KEY: "test-key" }, out: (l) => lines.push(l), readSet: () => SET, transportFor: () => transport })
    expect(code).toBe(1)
    const report = JSON.parse(lines[1]!) as { items: Array<{ problems: string[] }> }
    expect(report.items.every((i) => i.problems.join() === "transport_error:gateway_status")).toBe(true)
  })
})
