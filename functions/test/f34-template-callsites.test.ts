import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROMPT_TEMPLATE_PINS } from "@/platform/p1/promptTemplates"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { SYSTEM_POLICY_IDS, SYSTEM_POLICY_VERSION } from "@/platform/p1/systemPolicy"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { callP1, p1TestSeam, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { EMULATORS, uniq } from "./emu"

/**
 * Audit F34, spec ruling R3: every prompt the P1 path sends comes from a registered template, and a call site that sends
 * anything else fails. Statically: only `callP1` (gateway.ts) and the offline evaluation (evalSet.ts) may import a P1
 * transport (G-0 [21], audit F34 R1-003), and each builds its messages with `buildOutbound`, whose system message is the
 * registry text for the purpose. At run time: every purpose, and an unknown one, sends a system message whose SHA-256 is a pinned
 * template hash; an ad-hoc system text is refused and nothing is sent.
 */

const SRC = path.resolve(__dirname, "../src")
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

describe("F34 R3: the only P1 transport call sites build their prompt from the registry", () => {
  // Audit F34 R1-003 (spec ruling R17): the call-site regex this replaced matched two exact shapes and missed an ordinary
  // alias (`const gw = activeTransport(); await gw?.send(...)`). The rule is now an import rule, G-0 check [21]: only
  // gateway.ts and evalSet.ts (and the eval CLI, which hands evalSet.ts the Gateway transport and never sends) may import
  // a P1 transport. tests/f34-p1-transport-import-gate.test.ts plants the shapes it must fail on.
  it("only the granted send sites import a P1 transport (G-0 [21], ci_gates/check_p1_transport_imports.py)", () => {
    const res = spawnSync("python3", ["ci_gates/check_p1_transport_imports.py"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" })
    expect(`${res.stdout}${res.stderr}`).toContain("PASS: P1 transports are imported only by their grants")
    expect(res.status).toBe(0)
    const grants = JSON.parse(
      spawnSync("python3", ["ci_gates/check_p1_transport_imports.py", "--print-grants"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).stdout
    ) as { sendSites: string[] }
    expect(grants.sendSites).toEqual(["functions/src/p1/embedding.ts", "functions/src/p1/evalSet.ts", "functions/src/p1/gateway.ts"])
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

  it("a registry text that no longer hashes to its pin (edited without a version bump) is refused and nothing is sent", async () => {
    const firmId = uniq("firm")
    await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
    p1TestSeam.templatePins = { ...PROMPT_TEMPLATE_PINS, [`committee-brain@${SYSTEM_POLICY_VERSION}`]: sha256("an earlier text of the same version") }
    const blocked = await callP1(req(firmId, "committee-brain"), { now: () => Date.parse("2026-10-11T10:00:00.000Z") })
    expect([blocked.outcome, blocked.blockReason]).toEqual(["blocked", "system_unverified"])
    expect(systems).toEqual([])
    // Another template, still pinned, goes through.
    expect((await callP1(req(firmId, "summarise"), { now: () => Date.parse("2026-10-11T10:00:00.000Z") })).outcome).toBe("ok")
    expect(systems).toHaveLength(1)
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
