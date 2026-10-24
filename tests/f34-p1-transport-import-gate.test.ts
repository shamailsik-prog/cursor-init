import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Audit F34, re-audit FAIL at e37b115, FA-F34-R1-003 (spec docs/superpowers/specs/2026-10-24-f34-decision-trace-
 * reproducibility-design.md, ruling R17): G-0 check [21], ci_gates/check_p1_transport_imports.py. Only the granted files
 * may import a P1 transport; the call-site regex it replaces matched two exact shapes and let the auditor's ordinary
 * alias and a send placed in platform/ through. Each case plants files into a temporary tree holding the gate scripts and
 * the four granted files copied from this repository, runs the gate there, and expects it to fail and name what it found,
 * or to pass. The last cases run it on this repository and hold it consistent with F18's check [19]. On main the gate
 * does not exist, so every case here fails there.
 */

const repoRoot = process.cwd()
const GATE = "ci_gates/check_p1_transport_imports.py"
const GRANTED = ["functions/src/p1/gateway.ts", "functions/src/p1/evalSet.ts", "functions/src/p1/embedding.ts", "functions/src/cli/committeeEval.ts"]
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function probe(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f34-transport-gate-"))
  tmpDirs.push(dir)
  fs.mkdirSync(path.join(dir, "ci_gates"), { recursive: true })
  for (const name of ["check_p1_transport_imports.py", "g0_guard_common.py"]) {
    const src = path.join(repoRoot, "ci_gates", name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, "ci_gates", name))
  }
  for (const rel of GRANTED) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, rel), path.join(dir, rel))
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  return dir
}

function run(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const res = spawnSync("python3", [GATE, ...args], { cwd, encoding: "utf8", timeout: 60_000 })
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

type Case = { name: string; files: Record<string, string>; reports: string[] }

/** The auditor's planted shape T4 (re-audit evidence template-experiments.json), verbatim. */
const AUDIT_T4 =
  'import { activeTransport } from "./transport"\n\n' +
  "/** Auditor's planted ad-hoc call site: an unregistered system prompt sent straight to the transport. */\n" +
  "export async function adhocSummary(text: string): Promise<string | undefined> {\n" +
  "  const gw = activeTransport()\n" +
  '  const reply = await gw?.send({ messages: [{ role: "system", content: "You are a helpful assistant. Summarise." }, { role: "user", content: text }], model: "anthropic/claude-opus-5.5", maxTokens: 512 })\n' +
  "  return reply?.text\n" +
  "}\n"
/** The auditor's planted shape T4b: the send lives in platform/p1, the transport is fetched in functions/src. */
const AUDIT_T4B_PLATFORM =
  "type T = { send(r: { model: string; messages: { role: string; content: string }[]; maxTokens: number }): Promise<{ text?: unknown }> }\n" +
  "export async function adhocSend(t: T, text: string) {\n" +
  '  return t.send({ model: "anthropic/claude-opus-5.5", messages: [{ role: "system", content: "Ad hoc." }, { role: "user", content: text }], maxTokens: 512 })\n' +
  "}\n"
const AUDIT_T4B_FUNCTIONS =
  'import { adhocSend } from "@/platform/p1/zzAuditAdhoc"\nimport { activeTransport } from "./transport"\n' +
  "export const adhoc = (text: string) => adhocSend(activeTransport()!, text)\n"

const FAILING: Case[] = [
  {
    name: "the auditor's T4: an alias of activeTransport() in a new functions/src file",
    files: { "functions/src/p1/zzAuditAdhoc.ts": AUDIT_T4 },
    reports: ["functions/src/p1/zzAuditAdhoc.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "the auditor's T4b: the send in platform/p1, the transport fetched in functions/src",
    files: { "platform/p1/zzAuditAdhoc.ts": AUDIT_T4B_PLATFORM, "functions/src/p1/zzAuditAdhoc2.ts": AUDIT_T4B_FUNCTIONS },
    reports: ["functions/src/p1/zzAuditAdhoc2.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "a type-only import of P1Transport in platform/",
    files: { "platform/p1/x.ts": 'import type { P1Transport } from "@/functions/src/p1/transport"\nexport const go = (t: P1Transport) => t\n' },
    reports: ["platform/p1/x.ts: imports P1Transport from functions/src/p1/transport"],
  },
  {
    name: "an inline type specifier beside an allowed name",
    files: { "functions/src/p1/x.ts": 'import { modelId, type P1Transport } from "./transport"\nexport const go = (t: P1Transport) => [t, modelId]\n' },
    reports: ["functions/src/p1/x.ts: imports P1Transport from functions/src/p1/transport"],
  },
  {
    name: "a renamed import, with a comment between the tokens and a .js extension",
    files: { "functions/src/d4/x.ts": 'import { gatewayTransport as gt, modelId } /* why */ from "../p1/transport.js"\nexport const t = gt\nexport const m = modelId\n' },
    reports: ["functions/src/d4/x.ts: imports gatewayTransport from functions/src/p1/transport"],
  },
  {
    name: "a namespace import",
    files: { "functions/src/p2/x.ts": 'import * as t from "../p1/transport"\nexport const a = t.activeTransport\n' },
    reports: ["functions/src/p2/x.ts: imports all of functions/src/p1/transport"],
  },
  {
    name: "a multi-line import in services/ through a bare repository path",
    files: { "services/d5-1/x.ts": 'import {\n  activeTransport,\n} from "functions/src/p1/transport"\nexport const a = activeTransport\n' },
    reports: ["services/d5-1/x.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "a require() of the transport",
    files: { "functions/src/p1/x.ts": 'const { activeTransport } = require("./transport")\nexport const a = activeTransport\n' },
    reports: ["functions/src/p1/x.ts: loads functions/src/p1/transport dynamically"],
  },
  {
    name: "a dynamic import() of the transport",
    files: { "functions/src/p1/x.ts": 'export const load = async () => (await import("./transport")).activeTransport()\n' },
    reports: ["functions/src/p1/x.ts: loads functions/src/p1/transport dynamically"],
  },
  {
    name: "a computed import() in functions/src",
    files: { "functions/src/p1/x.ts": 'const where = "./trans" + "port"\nexport const load = () => import(where)\n' },
    reports: ["functions/src/p1/x.ts: computed module load"],
  },
  {
    name: "a template-literal import() with a substitution",
    files: { "platform/p1/x.ts": "const p = 'functions/src/p1/transport'\nexport const load = () => import(`@/${p}`)\n" },
    reports: ["platform/p1/x.ts: computed module load"],
  },
  {
    name: "export * from the transport (a barrel)",
    files: { "functions/src/p1/barrel.ts": 'export * from "./transport"\n' },
    reports: ["functions/src/p1/barrel.ts: re-exports all of functions/src/p1/transport"],
  },
  {
    name: "a re-export of a restricted name",
    files: { "functions/src/p1/barrel.ts": 'export { activeTransport as t } from "./transport"\n' },
    reports: ["functions/src/p1/barrel.ts: re-exports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "the embedding transport imported outside embedding.ts",
    files: { "functions/src/p1/corpusShortcut.ts": 'import { activeEmbeddingTransport } from "./embeddingTransport"\nexport const e = activeEmbeddingTransport\n' },
    reports: ["functions/src/p1/corpusShortcut.ts: imports activeEmbeddingTransport from functions/src/p1/embeddingTransport"],
  },
  {
    name: "a granted file importing the test seam",
    files: { "functions/src/p1/evalSet.ts": 'import { setP1TransportForTests, type P1Transport } from "./transport"\nexport const s = setP1TransportForTests\nexport type T = P1Transport\n' },
    reports: ["functions/src/p1/evalSet.ts: imports setP1TransportForTests from functions/src/p1/transport"],
  },
  {
    name: "the granted CLI calling send itself",
    files: {
      "functions/src/cli/committeeEval.ts":
        'import { gatewayTransport } from "../p1/transport"\nexport const go = (k: string) => gatewayTransport(k).send({ model: "m", messages: [{ role: "system", content: "Ad hoc." }], maxTokens: 1 })\n',
    },
    reports: ["functions/src/cli/committeeEval.ts: calls send or embed"],
  },
  {
    name: "a granted file handing the transport on",
    files: { "functions/src/p1/gateway.ts": 'import { activeTransport } from "./transport"\nexport { activeTransport }\n' },
    reports: ["functions/src/p1/gateway.ts: re-exports activeTransport"],
  },
  {
    name: "a vi.importActual of the transport in source",
    files: { "lib/x.ts": 'export const load = () => vi.importActual<Record<string, unknown>>("@/functions/src/p1/transport")\n' },
    reports: ["lib/x.ts: loads functions/src/p1/transport dynamically"],
  },
]

describe("audit F34 R1-003: G-0 [21] p1-transport-import guard (R17)", () => {
  it.each(FAILING)("fails: $name", ({ files, reports }) => {
    const r = run(probe(files))
    for (const report of reports) expect(r.out).toContain(report)
    expect(r.out).toContain("FAIL: a P1 transport is imported outside its grants")
    expect(r.status).toBe(1)
  })

  it("fails on a stale grant (a granted file that no longer exists)", () => {
    const dir = probe({})
    fs.rmSync(path.join(dir, "functions/src/cli/committeeEval.ts"))
    const r = run(dir)
    expect(r.out).toContain("functions/src/cli/committeeEval.ts: stale grant for functions/src/p1/transport")
    expect(r.status).toBe(1)
  })

  it.each([
    ["the granted files alone", {}],
    ["a non-restricted import from the transport anywhere", { "functions/src/p1/x.ts": 'import { modelId, plainId, P1TransportError, type P1TransportReply } from "./transport"\nexport const a = [modelId, plainId, P1TransportError]\nexport type R = P1TransportReply\n' }],
    ["a side-effect import (binds nothing)", { "functions/src/p1/x.ts": 'import "./transport"\n' }],
    ["a test under functions/test using the seams", { "functions/test/x.test.ts": 'import { setP1TransportForTests, type P1Transport } from "../src/p1/transport"\nexport const s = setP1TransportForTests\nexport type T = P1Transport\n' }],
    ["prose that names the transport", { "functions/src/p1/x.ts": '// values come from "./transport" in the gateway\nexport const note = "see the gateway"\n' }],
    [
      "prose in comments that reads like a computed load",
      { "platform/corpus/x.ts": "// that module is not one the Next runtime may import (audit F18), so it is restated\n/* they require (at least) a reader */\nexport const url = \"https://example.invalid/a\" // trailing\n" },
    ],
  ])("passes: %s", (_name, files) => {
    const r = run(probe(files as Record<string, string>))
    expect(r.out).toContain("PASS: P1 transports are imported only by their grants")
    expect(r.status).toBe(0)
  })

  it("passes on this repository", () => {
    const r = run(repoRoot)
    expect(r.out).toContain("PASS: P1 transports are imported only by their grants")
    expect(r.status).toBe(0)
  })

  it("grants the chat transport to gateway.ts and evalSet.ts, the embedding transport to embedding.ts, and the eval CLI only gatewayTransport and P1Transport", () => {
    const r = run(repoRoot, "--print-grants")
    expect(r.status).toBe(0)
    const printed = JSON.parse(r.out) as { grants: Record<string, Record<string, string[]>>; sendSites: string[] }
    expect(printed.grants).toEqual({
      "functions/src/p1/transport": {
        "functions/src/p1/gateway.ts": ["activeTransport", "gatewayTransport", "P1Transport"],
        "functions/src/p1/evalSet.ts": ["activeTransport", "gatewayTransport", "P1Transport"],
        "functions/src/cli/committeeEval.ts": ["gatewayTransport", "P1Transport"],
      },
      "functions/src/p1/embeddingTransport": {
        "functions/src/p1/embedding.ts": ["activeEmbeddingTransport", "gatewayEmbeddingTransport", "P1EmbeddingTransport"],
      },
    })
    expect(printed.sendSites).toEqual(["functions/src/p1/embedding.ts", "functions/src/p1/evalSet.ts", "functions/src/p1/gateway.ts"])
  })

  it("is consistent with F18's check [19]: no pure Functions module is a transport or a grant holder, and none loads a transport", () => {
    const pure = JSON.parse(spawnSync("python3", ["ci_gates/check_next_ai_egress.py", "--print-pure-modules"], { cwd: repoRoot, encoding: "utf8" }).stdout) as string[]
    const printed = JSON.parse(run(repoRoot, "--print-grants").out) as { restricted: Record<string, string[]>; grants: Record<string, Record<string, string[]>> }
    const guarded = new Set([...Object.keys(printed.restricted), ...Object.values(printed.grants).flatMap((g) => Object.keys(g).map((f) => f.replace(/\.ts$/, "")))])
    expect(pure.length).toBeGreaterThan(0)
    for (const pureModule of pure) {
      expect(guarded.has(pureModule), pureModule).toBe(false)
      const text = fs.readFileSync(path.join(repoRoot, `${pureModule}.ts`), "utf8")
      expect(text, pureModule).not.toMatch(/["'`][^"'`]*\/(?:transport|embeddingTransport)(?:\.[cm]?[jt]s)?["'`]/)
    }
  })

  it("is G-0 check [21]", () => {
    const g0 = fs.readFileSync(path.join(repoRoot, "ci_gates", "gate_g0.sh"), "utf8")
    expect(g0).toMatch(/echo "\[21\] p1-transport-import guard[^\n]*"\npython3 ci_gates\/check_p1_transport_imports\.py \|\| fail=1/)
  })
})
