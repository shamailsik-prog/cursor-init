import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROMPT_TEMPLATE_PINS } from "@/platform/p1/promptTemplates"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { SYSTEM_POLICY_IDS } from "@/platform/p1/systemPolicy"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { callP1, p1TestSeam, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { EMULATORS, uniq } from "./emu"

/**
 * Audit F34, spec ruling R3: every prompt the P1 path sends comes from a registered template, and a call site that sends
 * anything else fails. Statically: in functions/src only `callP1` (gateway.ts) and the offline evaluation (evalSet.ts)
 * call a P1 transport's `send`, and each builds its messages with `buildOutbound`, whose system message is the registry
 * text for the purpose. At run time: every purpose, and an unknown one, sends a system message whose SHA-256 is a pinned
 * template hash; an ad-hoc system text is refused and nothing is sent.
 */

const SRC = path.resolve(__dirname, "../src")
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : []
  })
}

describe("F34 R3: the only P1 transport call sites build their prompt from the registry", () => {
  const SEND_SITE = /\btransport\.send\(|\.send\(\s*\{\s*model\b/

  it("only gateway.ts and evalSet.ts send through a P1 transport", () => {
    const sites = sources(SRC)
      .filter((p) => SEND_SITE.test(readFileSync(p, "utf8")))
      .map((p) => path.relative(SRC, p))
      .sort()
    expect(sites).toEqual(["p1/evalSet.ts", "p1/gateway.ts"])
  })

  it("each of them builds the messages it sends with buildOutbound and sends those messages", () => {
    for (const file of ["p1/evalSet.ts", "p1/gateway.ts"]) {
      const text = readFileSync(path.join(SRC, file), "utf8")
      expect(text, file).toMatch(/\bbuildOutbound\(/)
      expect(text, file).toMatch(/\.send\(\{\s*model[^}]*\bmessages\b/)
    }
  })
})

describe.skipIf(!EMULATORS)("F34 R3: what callP1 sends is a pinned template (emulator)", () => {
  const pins = new Set(Object.values(PROMPT_TEMPLATE_PINS))
  let systems: string[] = []

  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
    systems = []
    setP1TransportForTests({
      async send(r) {
        systems.push(r.messages[0]!.content)
        return { text: "OK", inputTokens: 1, outputTokens: 1 }
      },
    })
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    await platformConfigRef().delete()
  })

  const req = (firmId: string, purpose: string): P1Request => ({
    firmId,
    actorId: "uid-1",
    matterId: "matter-1",
    jobId: null,
    taskType: "committee",
    classification: "internal",
    body: "Draft a reply to the notice.",
    purpose,
  })

  it("every registered purpose, and an unknown one, sends a system message whose hash is pinned", async () => {
    const firmId = uniq("firm")
    await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
    for (const purpose of [...SYSTEM_POLICY_IDS, "not-a-registered-purpose"]) {
      const r = await callP1(req(firmId, purpose), { now: () => Date.parse("2026-10-11T10:00:00.000Z") })
      expect(r.outcome, purpose).toBe("ok")
    }
    expect(systems).toHaveLength(SYSTEM_POLICY_IDS.length + 1)
    for (const s of systems) expect(pins.has(sha256(s))).toBe(true)
    await firmConfigRef(firmId).delete()
  })

  it("an ad-hoc system text is refused and nothing is sent", async () => {
    const firmId = uniq("firm")
    await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
    p1TestSeam.systemOverride = "You are an unregistered prompt."
    const r = await callP1(req(firmId, "committee-brain"), { now: () => Date.parse("2026-10-11T10:00:00.000Z") })
    expect([r.outcome, r.blockReason]).toEqual(["blocked", "system_unverified"])
    expect(systems).toEqual([])
    await firmConfigRef(firmId).delete()
  })
})
