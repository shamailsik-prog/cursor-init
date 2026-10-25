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
/**
 * Round-2 follow-up (FA-F34-R2-001, spec R29, R32): the transport modules and the two tsconfig files are copied in too, so a
 * bare specifier resolves the way esbuild resolves it in the deployed bundle (functions/tsconfig.json `baseUrl: "."`), and
 * so are the two other files that hold a Gateway key-name or host grant (a grant whose file is missing fails).
 */
const CONTEXT = [
  "functions/src/p1/transport.ts",
  "functions/src/p1/embeddingTransport.ts",
  "functions/src/p1/costTable.ts",
  "platform/p1/providerKeyGuard.ts",
  "functions/tsconfig.json",
  "tsconfig.json",
]
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function probe(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f34-transport-gate-"))
  tmpDirs.push(dir)
  fs.mkdirSync(path.join(dir, "ci_gates"), { recursive: true })
  for (const name of ["check_p1_transport_imports.py", "g0_guard_common.py", "js_lexer.py"]) {
    const src = path.join(repoRoot, "ci_gates", name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, "ci_gates", name))
  }
  for (const rel of [...GRANTED, ...CONTEXT]) {
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
  // PR #129 review, Codex P2 (thread 4368766679): a grant is per name, but a whole-module binding in a granted file
  // reached every restricted name, and a value derived from a restricted name could be re-exported under a new name.
  {
    name: "Codex P2 #1: the granted eval CLI importing the whole transport and handing on activeTransport()",
    files: { "functions/src/cli/committeeEval.ts": 'import * as transport from "../p1/transport"\nconst t = transport.activeTransport()\nexport { t }\n' },
    reports: ["functions/src/cli/committeeEval.ts: imports all of functions/src/p1/transport", "functions/src/cli/committeeEval.ts: re-exports t"],
  },
  {
    name: "Codex P2 #1: gateway.ts re-exporting setP1TransportForTests through an alias",
    files: { "functions/src/p1/gateway.ts": 'import * as transport from "./transport"\nconst reset = transport.setP1TransportForTests\nexport { reset }\n' },
    reports: ["functions/src/p1/gateway.ts: imports all of functions/src/p1/transport", "functions/src/p1/gateway.ts: re-exports reset"],
  },
  {
    name: "Codex P2 #1: a granted file re-exporting a granted transport value through a local alias",
    files: { "functions/src/p1/evalSet.ts": 'import { activeTransport } from "./transport"\nconst t = activeTransport\nconst u = t\nexport { u as current }\n' },
    reports: ["functions/src/p1/evalSet.ts: re-exports u"],
  },
  {
    name: "Codex P2 #1: a default export of a value derived from a granted transport name",
    files: { "functions/src/p1/embedding.ts": 'import { activeEmbeddingTransport } from "./embeddingTransport"\nconst e = activeEmbeddingTransport()\nexport default e\n' },
    reports: ["functions/src/p1/embedding.ts: re-exports e"],
  },
  {
    name: "Codex P2 #1: a granted file loading the transport dynamically",
    files: { "functions/src/p1/evalSet.ts": 'const m = import("./transport")\nexport const go = () => m\n' },
    reports: ["functions/src/p1/evalSet.ts: loads functions/src/p1/transport dynamically"],
  },
  {
    name: "Codex P2 #1: a default import of the transport in a granted file",
    files: { "functions/src/p1/gateway.ts": 'import transport from "./transport"\nexport const x = transport\n' },
    reports: ["functions/src/p1/gateway.ts: imports all of functions/src/p1/transport"],
  },
  // PR #129 review, Codex P2 (thread 4368766681): the computed-load check must read the first token after the
  // parenthesis, and a literal must be the whole argument: concatenation is computed.
  {
    name: "Codex P2 #2: a literal concatenated into the specifier is a computed load",
    files: { "functions/src/p1/x.ts": 'export const load = () => import("./trans" + "port")\n' },
    reports: ["functions/src/p1/x.ts: computed module load"],
  },
  {
    name: "Codex P2 #2: a spaced require of a concatenation across lines is a computed load",
    files: { "services/d5-1/x.ts": 'export const load = () => require( "../../functions/src/p1/trans" +\n  "port" )\n' },
    reports: ["services/d5-1/x.ts: computed module load"],
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
    // PR #129 review, Codex P2 (thread 4368766681): literal dynamic imports written with whitespace or a comment.
    ["Codex P2 #2: import( \"./x\") with a space", { "functions/src/p1/x.ts": 'export const load = () => import( "./month")\n' }],
    ["Codex P2 #2: import( on its own line with the literal on the next", { "functions/src/p1/x.ts": 'export const load = () => import(\n  "./month"\n)\n' }],
    ["Codex P2 #2: require( './x' ) with spaces", { "platform/p1/x.ts": "export const load = () => require( './promptText' )\n" }],
    ["Codex P2 #2: a comment before the literal", { "services/d5-1/x.ts": 'export const load = () => import(/* lazy */ "./researchCorpus")\n' }],
    ["Codex P2 #2: a literal with import options", { "functions/src/p1/x.ts": 'export const load = () => import( "./data.json", { with: { type: "json" } })\n' }],
    ["Codex P2 #2: a template literal without a substitution", { "functions/src/p1/x.ts": "export const load = () => import( `./month`)\n" }],
    // Round 2 (R2-007, spec R35): evalSet.ts is granted the P1Transport type only, so this fixture moved to gateway.ts, which
    // is granted activeTransport and (R2-002, spec R34) uses it only as a direct call held in a local const.
    ["Codex P2 #1: a granted file's own locals derived from the transport, not exported", { "functions/src/p1/gateway.ts": 'import { activeTransport } from "./transport"\nexport async function run(): Promise<void> {\n  const transport = activeTransport()\n  if (transport !== null) await transport.send({ model: "m", messages: [], maxTokens: 1 })\n}\n' }],
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

  it("grants gateway.ts activeTransport, evalSet.ts the P1Transport type, embedding.ts activeEmbeddingTransport, and the eval CLI gatewayTransport and P1Transport", () => {
    const r = run(repoRoot, "--print-grants")
    expect(r.status).toBe(0)
    const printed = JSON.parse(r.out) as {
      restricted: Record<string, string[]>
      grants: Record<string, Record<string, string[]>>
      sendSites: string[]
      keyNameGrants: string[]
      hostGrants: Record<string, string[]>
    }
    // Round 2 (R2-007, spec R35): each grant is exactly the names the file imports.
    expect(printed.grants).toEqual({
      "functions/src/p1/transport": {
        "functions/src/p1/gateway.ts": ["activeTransport"],
        "functions/src/p1/evalSet.ts": ["P1Transport"],
        "functions/src/cli/committeeEval.ts": ["gatewayTransport", "P1Transport"],
      },
      "functions/src/p1/embeddingTransport": {
        "functions/src/p1/embedding.ts": ["activeEmbeddingTransport"],
      },
    })
    expect(printed.sendSites).toEqual(["functions/src/p1/embedding.ts", "functions/src/p1/evalSet.ts", "functions/src/p1/gateway.ts"])
    // Round 2 (R2-001, spec R32): the Gateway URLs are restricted names granted to no file, and the key names and the host
    // are named only where the gate says.
    expect(printed.restricted["functions/src/p1/transport"]).toContain("GATEWAY_URL")
    expect(printed.restricted["functions/src/p1/embeddingTransport"]).toContain("EMBEDDINGS_URL")
    expect(printed.keyNameGrants).toEqual(["functions/src/cli/committeeEval.ts", "functions/src/p1/embeddingTransport.ts", "functions/src/p1/transport.ts", "platform/p1/providerKeyGuard.ts"])
    expect(printed.hostGrants).toEqual({
      "functions/src/p1/costTable.ts": ["https://ai-gateway.vercel.sh/v1/models"],
      "functions/src/p1/embeddingTransport.ts": ["https://ai-gateway.vercel.sh/v1/embeddings"],
      "functions/src/p1/transport.ts": ["https://ai-gateway.vercel.sh/v1/chat/completions"],
    })
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

/**
 * Round-2 independent re-audit FAIL 7/10 at 7987e39 (spec section 6, rulings R29 to R41; R26 to R28 are PR #130's). The auditor's planted shapes
 * (re-audit evidence tools/gate_plants.py, verbatim) passed [21] at 7987e39 and sent the ad hoc system text to the Gateway in
 * the deployed bundle (bundle-probe.json). Each must now fail [21] and name what it found. On main (798cf56) every case in
 * R2_FAILING passes the gate, so each fails there.
 */
const AD_HOC = '?.send({ model: "m", messages: [{ role: "system", content: "ad hoc" }], maxTokens: 8 })'
/** A granted file as it is in this repository, with `insertion` appended (the auditor's plants edit the real file). */
const appended = (rel: string, insertion: string): Record<string, string> => ({ [rel]: fs.readFileSync(path.join(repoRoot, rel), "utf8") + insertion })
const UNSCANNED = "from an unscanned directory"
const AS_VALUE = "other than as a direct call held in a local const"
const AS_TRANSPORT = "(a transport) other than as a .send/.embed receiver, an .id read, a null check or a runLiveEvaluation argument"

const R2_FAILING: Case[] = [
  // FA-F34-R2-001 (MEDIUM): new ungranted files in ordinary code.
  {
    name: "B16: a bare specifier that functions/tsconfig.json's baseUrl resolves to the transport",
    files: { "functions/src/p1/zzBase.ts": `import { activeTransport } from "src/p1/transport"\nexport const go = () => activeTransport()${AD_HOC}\n` },
    reports: ["functions/src/p1/zzBase.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "B16b: a bare specifier that the baseUrl resolves into functions/test/",
    files: { "functions/test/zzH.ts": 'export { activeTransport } from "../src/p1/transport"\n', "functions/src/p1/zzBase2.ts": `import { activeTransport } from "test/zzH"\nexport const go = () => activeTransport()${AD_HOC}\n` },
    reports: [`functions/src/p1/zzBase2.ts: imports functions/test/zzH ${UNSCANNED}`],
  },
  {
    name: "B01: a re-export through a helper in functions/test/, imported into functions/src",
    files: {
      "functions/test/zzHelper.ts": 'export { activeTransport } from "../src/p1/transport"\n',
      "functions/src/p1/zzUseHelper.ts": 'import { activeTransport } from "../../test/zzHelper"\nexport async function go() {\n  const gw = activeTransport()\n  return gw?.send({ model: "m", messages: [{ role: "system", content: "ad hoc" }], maxTokens: 8 })\n}\n',
    },
    reports: [`functions/src/p1/zzUseHelper.ts: imports functions/test/zzHelper ${UNSCANNED}`],
  },
  {
    name: "B02: a wrapper under the root tests/, imported through @/tests/",
    files: { "tests/zzWrap.ts": 'export { activeTransport } from "@/functions/src/p1/transport"\n', "functions/src/p1/zzUseTests.ts": `import { activeTransport } from "@/tests/zzWrap"\nexport const go = () => activeTransport()${AD_HOC}\n` },
    reports: [`functions/src/p1/zzUseTests.ts: imports tests/zzWrap ${UNSCANNED}`],
  },
  {
    name: "B02b: a wrapper under ci_gates/, imported through @/ci_gates/",
    files: { "ci_gates/zzWrap.ts": 'export { activeTransport } from "@/functions/src/p1/transport"\n', "functions/src/p1/zzUseCi.ts": 'import { activeTransport } from "@/ci_gates/zzWrap"\nexport const go = () => activeTransport()\n' },
    reports: [`functions/src/p1/zzUseCi.ts: imports ci_gates/zzWrap ${UNSCANNED}`],
  },
  {
    name: "G06b: a barrel directory under the root tests/",
    files: { "tests/zzbarrel/index.ts": 'export { activeTransport } from "@/functions/src/p1/transport"\n', "functions/src/p1/zzUseBarrel2.ts": 'import { activeTransport } from "@/tests/zzbarrel"\nexport const go = () => activeTransport()\n' },
    reports: [`functions/src/p1/zzUseBarrel2.ts: imports tests/zzbarrel ${UNSCANNED}`],
  },
  {
    name: "B15: a wrapper under functions/lib/",
    files: { "functions/lib/zzWrap.ts": 'export { activeTransport } from "../src/p1/transport"\n', "functions/src/p1/zzUseLib.ts": 'import { activeTransport } from "../../lib/zzWrap"\nexport const go = () => activeTransport()\n' },
    reports: [`functions/src/p1/zzUseLib.ts: imports functions/lib/zzWrap ${UNSCANNED}`],
  },
  {
    name: "a side-effect import of a file under .eve/",
    files: { ".eve/zz.ts": 'import { setP1TransportForTests } from "@/functions/src/p1/transport"\nsetP1TransportForTests(null)\n', "platform/p1/zzEve.ts": 'import "@/.eve/zz"\nexport const x = 1\n' },
    reports: [`platform/p1/zzEve.ts: imports .eve/zz ${UNSCANNED}`],
  },
  {
    name: "B03: a quoted import name",
    files: { "functions/src/p1/zzStrName.ts": `import { "activeTransport" as at } from "./transport"\nexport const go = () => at()${AD_HOC}\n` },
    reports: ["functions/src/p1/zzStrName.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "B04: an escaped specifier",
    files: { "functions/src/p1/zzEsc.ts": `import { activeTransport } from "./trans\\u0070ort"\nexport const go = () => activeTransport()${AD_HOC}\n` },
    reports: ["functions/src/p1/zzEsc.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "B05: an escaped identifier",
    files: { "functions/src/p1/zzUid.ts": `import { activ\\u0065Transport } from "./transport"\nexport const go = () => activeTransport()${AD_HOC}\n` },
    reports: ["functions/src/p1/zzUid.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "B05b: a \\x escape and a \\u{...} escape in the specifier",
    files: { "platform/p1/zzEsc2.ts": 'export { gatewayTransport } from "@/functions/src/p1/\\x74ransp\\u{6f}rt"\n' },
    reports: ["platform/p1/zzEsc2.ts: re-exports gatewayTransport from functions/src/p1/transport"],
  },
  {
    name: "B07: require held in a variable",
    files: { "functions/src/p1/zzReqAlias.ts": 'const r = require\nexport const go = () => r("./transport").activeTransport()\n' },
    reports: ["functions/src/p1/zzReqAlias.ts: uses require other than as a direct call"],
  },
  {
    name: "B08: module.require",
    files: { "functions/src/p1/zzModReq.ts": 'export const go = () => module.require("./transport").activeTransport()\n' },
    reports: ["functions/src/p1/zzModReq.ts: reaches a module loader through a member"],
  },
  {
    name: "B08b: a computed member of module",
    files: { "services/d5-1/zzModReq.ts": 'export const go = () => module["req" + "uire"]("../../functions/src/p1/transport")\n' },
    reports: ["services/d5-1/zzModReq.ts: reaches a module loader through a member"],
  },
  {
    name: "eval builds a loader at run time",
    files: { "functions/src/p1/zzEval.ts": 'export const go = () => eval("require")("./transport")\n' },
    reports: ["functions/src/p1/zzEval.ts: generates code at run time"],
  },
  {
    name: "a package.json subpath import (#...) the gate cannot resolve",
    files: { "functions/src/p1/zzHash.ts": 'import { activeTransport } from "#p1/transport"\nexport const go = () => activeTransport()\n' },
    reports: ["functions/src/p1/zzHash.ts: imports #p1/transport through a package.json subpath import"],
  },
  {
    name: "a tsconfig paths entry that maps a new alias onto the transport",
    files: {
      "functions/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["../*"], "zz-t": ["src/p1/transport"] } } }),
      "functions/src/p1/zzPaths.ts": 'import { activeTransport } from "zz-t"\nexport const go = () => activeTransport()\n',
    },
    reports: ["functions/src/p1/zzPaths.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "B09: fetch(GATEWAY_URL) with the Gateway key",
    files: {
      "functions/src/p1/zzRaw.ts":
        'import { GATEWAY_URL } from "./transport"\nexport async function go(text: string) {\n  return fetch(GATEWAY_URL, { method: "POST", headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-opus-5.5", messages: [{ role: "system", content: "ad hoc system" }, { role: "user", content: text }] }) })\n}\n',
    },
    reports: ["functions/src/p1/zzRaw.ts: imports GATEWAY_URL from functions/src/p1/transport", "functions/src/p1/zzRaw.ts: names the AI Gateway key AI_GATEWAY_API_KEY"],
  },
  {
    name: "B09b: the Gateway URL written out, and the key name folded from two literals",
    files: {
      "functions/src/d4/zzRaw2.ts":
        'export const go = (text: string) =>\n  fetch("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${process.env["AI_GATEWAY" + "_API_KEY"]}` }, body: text })\n',
    },
    reports: ["functions/src/d4/zzRaw2.ts: names the AI Gateway host", "functions/src/d4/zzRaw2.ts: names the AI Gateway key AI_GATEWAY_API_KEY"],
  },
  {
    name: "the embeddings URL imported outside embeddingTransport.ts",
    files: { "functions/src/p1/zzEmbUrl.ts": 'import { EMBEDDINGS_URL } from "./embeddingTransport"\nexport const u = EMBEDDINGS_URL\n' },
    reports: ["functions/src/p1/zzEmbUrl.ts: imports EMBEDDINGS_URL from functions/src/p1/embeddingTransport"],
  },
  {
    name: "the Vercel key name read in services/",
    files: { "services/d5-1/zzKey.ts": "export const k = () => process.env.VERCEL_AI_GATEWAY_API_KEY\n" },
    reports: ["services/d5-1/zzKey.ts: names the AI Gateway key VERCEL_AI_GATEWAY_API_KEY"],
  },
  {
    name: "a granted host file naming another Gateway path",
    files: { "functions/src/p1/transport.ts": `${fs.readFileSync(path.join(repoRoot, "functions/src/p1/transport.ts"), "utf8")}\nexport const zzOther = "https://ai-gateway.vercel.sh/v1/responses"\n` },
    reports: ["functions/src/p1/transport.ts: names the AI Gateway host"],
  },
  // X15 (round-2 auditor mutant, survived): a specifier's query and hash are stripped before it is resolved.
  {
    name: "X15: a query and a hash on the transport's specifier",
    files: { "functions/src/p1/zzQ.ts": 'import { activeTransport } from "./transport?x=1#y"\nexport const go = () => activeTransport()\n' },
    reports: ["functions/src/p1/zzQ.ts: imports activeTransport from functions/src/p1/transport"],
  },
  // X18 (survived): a granted file that is not a send site may not embed either.
  {
    name: "X18: the granted eval CLI calling embed",
    files: appended("functions/src/cli/committeeEval.ts", '\nexport const zzEmbed = (t: { embed(r: unknown): unknown }) => t.embed({ input: "x" })\n'),
    reports: ["functions/src/cli/committeeEval.ts: calls send or embed"],
  },
  // X20 (survived): `module.exports` / `export =` of a value derived from a transport.
  {
    name: "X20: module.exports of a value derived from the transport",
    files: { "functions/src/p1/gateway.ts": 'import { activeTransport } from "./transport"\nconst t = activeTransport()\nmodule.exports = { t }\n' },
    reports: ["functions/src/p1/gateway.ts: re-exports t"],
  },
  {
    name: "X20: export = of a value derived from the transport",
    files: { "functions/src/p1/embedding.ts": 'import { activeEmbeddingTransport } from "./embeddingTransport"\nconst e = activeEmbeddingTransport()\nexport = e\n' },
    reports: ["functions/src/p1/embedding.ts: re-exports e"],
  },
  // X21 (survived): an `as` alias of a granted name is tracked as the name it binds.
  {
    name: "X21: a value derived through an import alias, re-exported",
    files: { "functions/src/p1/gateway.ts": 'import { activeTransport as at } from "./transport"\nconst t = at()\nconst u = t\nexport { u }\n' },
    reports: ["functions/src/p1/gateway.ts: re-exports u"],
  },
  // FA-F34-R2-002 (LOW): laundering inside a granted file (spec R34): a restricted value may appear only as a direct call
  // held in a local const, and that const only as a .send/.embed receiver, an .id read, a null check or a
  // runLiveEvaluation argument.
  { name: "G01b: a three-line initializer", files: { ...appended("functions/src/p1/gateway.ts", "\nconst zzMl3 = (\n  activeTransport\n)\nexport { zzMl3 }\n"), "functions/src/p1/zzUseMl3.ts": 'import { zzMl3 } from "./gateway"\nexport const go = () => zzMl3()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "G02b: a multi-line object property", files: { ...appended("functions/src/p1/gateway.ts", "\nconst zzO2 = {\n  t: activeTransport,\n}\nexport { zzO2 }\n"), "functions/src/p1/zzUseO2.ts": 'import { zzO2 } from "./gateway"\nexport const go = () => zzO2.t()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "B13: an exported multi-line object property", files: { ...appended("functions/src/p1/gateway.ts", "\nexport const zzSeam = {\n  t: activeTransport,\n}\n"), "functions/src/p1/zzUseObj.ts": `import { zzSeam } from "./gateway"\nexport const go = () => zzSeam.t()${AD_HOC}\n` }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "G03: a getter", files: { ...appended("functions/src/p1/gateway.ts", "\nexport const zzG = {\n  get t() {\n    return activeTransport()\n  },\n}\n"), "functions/src/p1/zzUseG.ts": 'import { zzG } from "./gateway"\nexport const go = () => zzG.t\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "G04: a class field", files: { ...appended("functions/src/p1/gateway.ts", "\nexport class ZzC {\n  static t = activeTransport\n}\n"), "functions/src/p1/zzUseC.ts": 'import { ZzC } from "./gateway"\nexport const go = () => ZzC.t()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "G05: Reflect.get over a multi-line bag", files: { ...appended("functions/src/p1/gateway.ts", '\nconst zzBag = {\n  a: activeTransport,\n}\nexport const zzRef = Reflect.get(zzBag, "a")\n'), "functions/src/p1/zzUseR.ts": 'import { zzRef } from "./gateway"\nexport const go = () => (zzRef as () => unknown)()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "G07: a deferred assignment", files: { ...appended("functions/src/p1/gateway.ts", "\nlet zzD: unknown = null\nzzD = activeTransport\nexport { zzD }\n"), "functions/src/p1/zzUseD.ts": 'import { zzD } from "./gateway"\nexport const go = () => (zzD as () => unknown)()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "G08: globalThis", files: { ...appended("functions/src/p1/gateway.ts", "\n;(globalThis as Record<string, unknown>).zzT = activeTransport\n"), "functions/src/p1/zzUseGlobal.ts": 'import "./gateway"\nexport const go = () => ((globalThis as Record<string, unknown>).zzT as () => unknown)()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  {
    name: "G09: callback injection",
    files: {
      ...appended("functions/src/p1/gateway.ts", '\nimport { zzRegister } from "./zzRegistry"\nzzRegister(activeTransport)\n'),
      "functions/src/p1/zzRegistry.ts": "let held: unknown = null\nexport const zzRegister = (t: unknown) => {\n  held = t\n}\nexport const heldTransport = () => (held as () => unknown)()\n",
      "functions/src/p1/zzUseReg.ts": 'import "./gateway"\nimport { heldTransport } from "./zzRegistry"\nexport const go = () => heldTransport()\n',
    },
    reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`],
  },
  { name: "G10: a multi-line function returning the transport", files: { ...appended("functions/src/p1/gateway.ts", "\nexport function zzF() {\n  return activeTransport()\n}\n"), "functions/src/p1/zzUseF.ts": 'import { zzF } from "./gateway"\nexport const go = () => zzF()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  { name: "G11: an escaped identifier on an export line", files: { ...appended("functions/src/p1/gateway.ts", "\nexport const zzX = activ\\u0065Transport\n"), "functions/src/p1/zzUseX.ts": 'import { zzX } from "./gateway"\nexport const go = () => zzX()\n' }, reports: [`functions/src/p1/gateway.ts: uses activeTransport ${AS_VALUE}`] },
  {
    name: "B14: a computed send in the granted CLI",
    files: appended("functions/src/cli/committeeEval.ts", '\nasync function zzGo(k: string) {\n  const t = gatewayTransport(k) as unknown as Record<string, (r: unknown) => Promise<unknown>>\n  return t["se" + "nd"]({ model: "m", messages: [{ role: "system", content: "ad hoc" }], maxTokens: 8 })\n}\nexport { zzGo }\n'),
    reports: [`functions/src/cli/committeeEval.ts: uses gatewayTransport ${AS_VALUE}`],
  },
  // The appended fixtures name their transport const uniquely: a tracked name is tracked file-wide, and gateway.ts and
  // embedding.ts already hold an unrelated `t` (the test seam), which would satisfy the report for the wrong reason.
  { name: "a transport const returned from a function", files: appended("functions/src/p1/gateway.ts", "\nexport function zzPick() {\n  const zzT1 = activeTransport()\n  return zzT1\n}\n"), reports: [`functions/src/p1/gateway.ts: uses zzT1 ${AS_TRANSPORT}`] },
  { name: "a computed member on a transport const", files: appended("functions/src/p1/embedding.ts", '\nexport async function zzE() {\n  const zzT2 = activeEmbeddingTransport()\n  return zzT2?.["em" + "bed"]({ model: "m", input: "x" })\n}\n'), reports: [`functions/src/p1/embedding.ts: uses zzT2 ${AS_TRANSPORT}`] },
  { name: "a P1Transport parameter stored in module state", files: appended("functions/src/p1/evalSet.ts", "\nexport let zzHeld: unknown = null\nexport function zzKeep(transport: P1Transport) {\n  zzHeld = transport\n}\n"), reports: [`functions/src/p1/evalSet.ts: uses transport ${AS_TRANSPORT}`] },
  { name: "an exported const holding activeTransport()", files: appended("functions/src/p1/gateway.ts", "\nexport const zzT = activeTransport()\n"), reports: ["functions/src/p1/gateway.ts: re-exports activeTransport"] },
  // FA-F34-R2-007 (spec R35): a grant wider than what the file imports fails, so the grants stay tight.
  { name: "a grant the file no longer uses", files: { "functions/src/p1/gateway.ts": "export const x = 1\n" }, reports: ["functions/src/p1/gateway.ts: holds a grant for activeTransport from functions/src/p1/transport that it does not import"] },
  { name: "a key-name grant the file no longer uses", files: { "platform/p1/providerKeyGuard.ts": "export const x = 1\n" }, reports: ["platform/p1/providerKeyGuard.ts: holds a key-name grant it does not use"] },
  // The builder's own adversarial shapes (spec R33, R34): each passed an earlier draft of this rule or is a loader form the
  // audit did not plant.
  { name: "require destructured from module", files: { "functions/src/p1/zzModDes.ts": 'const { require: r } = module\nexport const go = () => r("./transport")\n' }, reports: ["functions/src/p1/zzModDes.ts: reaches a module loader through a member (module used as a value"] },
  { name: "process.mainModule.require", files: { "services/d5-1/zzMain.ts": 'export const go = () => process.mainModule?.require("../../functions/src/p1/transport")\n' }, reports: ["services/d5-1/zzMain.ts: reaches a module loader through a member"] },
  { name: "a loader reached through a member of another object", files: { "services/d5-1/zzHost.ts": 'export const go = (host: { require(p: string): unknown }) => host.require("../../functions/src/p1/transport")\n' }, reports: ["services/d5-1/zzHost.ts: reaches a module loader through a member (.require)"] },
  { name: "an optional call of require", files: { "functions/src/p1/zzOpt.ts": 'export const go = () => require?.("./transport")\n' }, reports: ["functions/src/p1/zzOpt.ts: uses require other than as a direct call"] },
  { name: "require through a comma expression", files: { "platform/p1/zzComma.ts": 'export const go = () => (0, require)("@/functions/src/p1/transport")\n' }, reports: ["platform/p1/zzComma.ts: uses require other than as a direct call"] },
  { name: "a createRequire loader passed on", files: { "functions/src/p1/zzCr2.ts": 'import { createRequire as cr } from "node:module"\nconst load = cr(__filename)\nexport const loader = [load]\n' }, reports: ["functions/src/p1/zzCr2.ts: uses load other than as a direct call"] },
  { name: "new Function builds a loader", files: { "functions/src/p1/zzFn.ts": 'export const go = () => new Function("return require")()("./transport")\n' }, reports: ["functions/src/p1/zzFn.ts: generates code at run time (Function)"] },
  { name: "the vm module", files: { "services/d5-1/zzVm.ts": 'import vm from "node:vm"\nexport const go = (s: string) => vm.runInThisContext(s)\n' }, reports: ["services/d5-1/zzVm.ts: generates code at run time (the vm module)"] },
  { name: "a re-export of everything from an unscanned directory", files: { "tests/zzAll.ts": 'export * from "@/functions/src/p1/transport"\n', "functions/src/p1/zzAll.ts": 'export * from "@/tests/zzAll"\n' }, reports: ["functions/src/p1/zzAll.ts: imports tests/zzAll from an unscanned directory"] },
  { name: "a wrapper in an unscanned tree imported from the root lib/, which the Functions bundle may import", files: { "tests/zzLibWrap.ts": 'export { activeTransport } from "@/functions/src/p1/transport"\n', "lib/zzBridge.ts": 'export { activeTransport } from "@/tests/zzLibWrap"\n' }, reports: ["lib/zzBridge.ts: imports tests/zzLibWrap from an unscanned directory"] },
  { name: "an import the gate cannot read", files: { "functions/src/p1/zzOdd.ts": 'import source t from "./transport"\nexport const go = () => t\n' }, reports: ["functions/src/p1/zzOdd.ts: an import statement the gate cannot read (line 1)"] },
  {
    name: "a granted file's own runLiveEvaluation, which keeps the transport",
    files: appended("functions/src/p1/gateway.ts", "\nlet zzKept: unknown = null\nfunction runLiveEvaluation(_s: unknown, held: unknown) {\n  zzKept = held\n}\nexport async function zzGo() {\n  const zzT3 = activeTransport()\n  runLiveEvaluation(null, zzT3)\n  return zzKept\n}\n"),
    reports: ["functions/src/p1/gateway.ts: uses zzT3 (a transport)"],
  },
  { name: "a transport const read as a ternary branch on its own line", files: appended("functions/src/p1/embedding.ts", "\nexport function zzPick(c: boolean) {\n  const zzT4 = activeEmbeddingTransport()\n  const u = c ?\n    zzT4\n    : null\n  return u\n}\n"), reports: ["functions/src/p1/embedding.ts: uses zzT4 (a transport)"] },
]

describe("audit F34 round 2 (FA-F34-R2-001, -002, -005, -007): G-0 [21] has no ordinary-code bypass (R29 to R36)", () => {
  it.each(R2_FAILING)("fails: $name", ({ files, reports }) => {
    const r = run(probe(files))
    for (const report of reports) expect(r.out).toContain(report)
    expect(r.out).toContain("FAIL: a P1 transport is imported outside its grants")
    expect(r.status).toBe(1)
  })

  it.each([
    // FA-F34-R2-004 (spec R36): loader calls inside string, template and regex literals are text, not loads.
    ["F05: a string that mentions require(name)", { "functions/src/p1/zzFp5.ts": 'export const help = "call require(name) with a literal"\n' }],
    ["a template literal's text that mentions import(x)", { "platform/p1/zzFp6.ts": "export const help = (n: string) => `use import(x) for ${n}, not require(y)`\n" }],
    ["a regex literal that mentions require(", { "services/d5-1/zzFp7.ts": "export const re = /require\\(|import\\(/g\nexport const n = 4 / 2 / 1\n" }],
    // Comments are not code: the key name and the host in a comment, in a file outside the grants.
    ["the key name and the Gateway host in comments", { "functions/src/p1/zzFp8.ts": "// AI_GATEWAY_API_KEY is bound to the api function; see https://ai-gateway.vercel.sh/v1/models\n/* VERCEL_AI_GATEWAY_API_KEY */\nexport const x = 1\n" }],
    ["require.main === module in a CLI", { "functions/src/cli/zzCli.ts": "async function main(): Promise<void> {}\nif (require.main === module) void main()\n" }],
    // A granted file's own transport const, read for its id and null-checked, sending.
    [
      "a granted file's transport const used as a receiver, for its id and in null checks",
      {
        "functions/src/p1/gateway.ts":
          'import { activeTransport } from "./transport"\nexport async function run(blocked: boolean) {\n  const transport = blocked ? null : activeTransport()\n  if (transport === null) return null\n  const id = transport.id ?? "unidentified"\n  return [id, await transport!.send({ model: "m", messages: [], maxTokens: 1 })]\n}\n',
      },
    ],
    [
      "the eval CLI handing its transport const to runLiveEvaluation",
      {
        "functions/src/cli/committeeEval.ts":
          'import { runLiveEvaluation } from "../p1/evalSet"\nimport { gatewayTransport, type P1Transport } from "../p1/transport"\nexport async function go(deps: { env: Record<string, string | undefined>; transportFor?: (k: string) => P1Transport }) {\n  const key = deps.env.AI_GATEWAY_API_KEY ?? ""\n  const transport = deps.transportFor === undefined ? gatewayTransport(key) : deps.transportFor(key)\n  return runLiveEvaluation({} as never, transport, { model: "m" })\n}\n',
      },
    ],
    // A P1Transport parameter in a send site, used only as the receiver of .send (evalSet.ts's runLiveEvaluation).
    ["a P1Transport parameter used as a .send receiver", { "functions/src/p1/evalSet.ts": 'import type { P1Transport } from "./transport"\nexport async function run(transport: P1Transport) {\n  return transport.send({ model: "m", messages: [], maxTokens: 1 })\n}\n' }],
    // A type-literal or object key that shares the transport const's name is a key, not a read, on its own line too.
    [
      "keys named like the transport const, in a type literal and an object literal",
      {
        "functions/src/p1/gateway.ts":
          'import { activeTransport } from "./transport"\ntype Phases = {\n  first: number\n  transport: number\n}\nexport const PHASES: Phases = {\n  first: 1,\n  transport: 60,\n}\nexport async function run() {\n  const transport = activeTransport()\n  return { transport: transport === null ? null : 1, reply: await transport?.send({ model: "m", messages: [], maxTokens: 1 }) }\n}\n',
      },
    ],
    // An annotated const holding the call.
    ["an annotated transport const", { "functions/src/p1/embedding.ts": 'import { activeEmbeddingTransport } from "./embeddingTransport"\nimport type { P1EmbeddingTransportError } from "./embeddingTransport"\nexport async function run(): Promise<unknown> {\n  const t: ReturnType<typeof Object> | null = activeEmbeddingTransport()\n  return t === null ? null : t.embed({ model: "m", input: "x" })\n}\nexport type E = P1EmbeddingTransportError\n' }],
  ])("passes: %s", (_name, files) => {
    const r = run(probe(files as Record<string, string>))
    expect(r.out).toContain("PASS: P1 transports are imported only by their grants")
    expect(r.status).toBe(0)
  })
})
