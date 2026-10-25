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
/** FA-F34-R2-001 (R29, R32): resolution and key/host grant context for probe trees. */
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
  for (const name of [
    "check_p1_transport_imports.py",
    "g0_guard_common.py",
    "js_lexer.py",
    "check_p1_transport_granted_exports.ts",
    "granted_p1_transport_export_allowlist.json",
  ]) {
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
  const res = spawnSync("python3", [GATE, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, SIKANDER_GATE_TOOL_ROOT: repoRoot },
  })
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

const VIOLATION = "granted export violation"

function overlayGranted(rel: string, patch: string): string {
  return `${fs.readFileSync(path.join(repoRoot, rel), "utf8")}\n${patch}\n`
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
    reports: [VIOLATION],
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
    reports: ["functions/src/cli/committeeEval.ts: imports all of functions/src/p1/transport", VIOLATION],
  },
  {
    name: "Codex P2 #1: gateway.ts re-exporting setP1TransportForTests through an alias",
    files: { "functions/src/p1/gateway.ts": 'import * as transport from "./transport"\nconst reset = transport.setP1TransportForTests\nexport { reset }\n' },
    reports: ["functions/src/p1/gateway.ts: imports all of functions/src/p1/transport", VIOLATION],
  },
  {
    name: "Codex P2 #1: a granted file re-exporting a granted transport value through a local alias",
    files: { "functions/src/p1/evalSet.ts": 'import { activeTransport } from "./transport"\nconst t = activeTransport\nconst u = t\nexport { u as current }\n' },
    reports: [VIOLATION],
  },
  {
    name: "Codex P2 #1: a default export of a value derived from a granted transport name",
    files: { "functions/src/p1/embedding.ts": 'import { activeEmbeddingTransport } from "./embeddingTransport"\nconst e = activeEmbeddingTransport()\nexport default e\n' },
    reports: [VIOLATION],
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
  {
    name: "FA-F34-R2-001: a granted file exports a multi-line arrow that returns the transport (residual 11)",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport const leak = () =>\n  activeTransport()\n',
    },
    reports: [`functions/src/p1/evalSet.ts: ${VIOLATION}`],
  },
  {
    name: "FA-F34-R2-001: a granted file exports a multi-line object holding the transport (residual 11)",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport const bundle = {\n  gw: activeTransport(),\n}\n',
    },
    reports: [`functions/src/p1/evalSet.ts: ${VIOLATION}`],
  },
  {
    name: "FA-F34-R2-001: a granted file exports a function that returns the transport (residual 11)",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport function leakTransport() {\n  return activeTransport()\n}\n',
    },
    reports: [`functions/src/p1/evalSet.ts: ${VIOLATION}`],
  },
  {
    name: "FA-F34-R3-001: typed return P1Transport",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport function pickGateway(): P1Transport {\n  return activeTransport()!\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: Promise<P1Transport> return",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport async function pickGateway(): Promise<P1Transport> {\n  return activeTransport()!\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: default parameter with parentheses",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport function pickGateway(x = (activeTransport()!)): P1Transport {\n  return x\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: return object literal",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport function pickGateway() {\n  return { gw: activeTransport() }\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: export default function",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport default function pickGateway(): P1Transport {\n  return activeTransport()!\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: export default object",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport default { gw: activeTransport() }\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: class instance field",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport class Holder {\n  gw = activeTransport()\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: class static method",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport class Holder {\n  static pick(): P1Transport {\n    return activeTransport()!\n  }\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: bind then export by name",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nconst slot = activeTransport()\nexport { slot }\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: generator yield",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport function* streamGateway(): Generator<P1Transport> {\n  yield activeTransport()!\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: assign after declaration then export",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nlet slot: P1Transport | null = null\nslot = activeTransport()!\nexport { slot }\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: Object.assign into an export",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport const merged = Object.assign({}, { gw: activeTransport() })\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: Map holder export",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nexport const holders = new Map([["k", activeTransport()]])\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-001: renamed import then export",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport as pickGw } from "./transport"\nexport function pickGateway() {\n  return pickGw()!\n}\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34C-001 B11: export let then assign later",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport let sink: P1Transport | null = null\nsink = activeTransport()!\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34C-001 B11: assign in helper then export by name",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nlet sink: P1Transport | null = null\nfunction fill() {\n  sink = activeTransport()!\n}\nfill()\nexport { sink }\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34C-001 B12: stash on globalThis then export accessor",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'import { activeTransport } from "./transport"\n;(globalThis as { gw?: unknown }).gw = activeTransport()\nexport const readGw = () => (globalThis as { gw?: unknown }).gw\n',
      ),
    },
    reports: ["forbidden environment write"],
  },
  {
    name: "FA-F34C-001 B13: hand transport through callback parameter",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport, type P1Transport } from "./transport"\nexport const invoke = (handler: (t: P1Transport) => void) => handler(activeTransport()!)\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34C-001 B17: Object.assign(exports, payload)",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'import { activeTransport } from "./transport"\nObject.assign(exports, { gateway: activeTransport() })\n',
      ),
    },
    reports: ["forbidden environment write"],
  },
  {
    name: "FA-F34C-001 B20: Map filled with set then exported",
    files: {
      "functions/src/p1/evalSet.ts":
        'import { activeTransport } from "./transport"\nconst registry = new Map<string, unknown>()\nregistry.set("gw", activeTransport())\nexport { registry }\n',
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R4-001 B5: non-exported const then export by name",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'import { activeTransport } from "./transport"\nconst slot = activeTransport()\nexport { slot }\n',
      ),
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R4-001 B8b: object getter returns transport",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'import { activeTransport } from "./transport"\nexport const holder = { get gateway() { return activeTransport()! } }\n',
      ),
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R4-001 B13: callback in block body",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'import { activeTransport, type P1Transport } from "./transport"\nexport function runProbeCb(cb: (t: P1Transport) => void) {\n  cb(activeTransport()!)\n}\n',
      ),
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R4-001 B19: var in block then export",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'import { activeTransport } from "./transport"\n{ var g = activeTransport()! }\nexport { g }\n',
      ),
    },
    reports: [VIOLATION],
  },
  {
    name: "FA-F34-R3-002: eval(require) loader",
    files: { "functions/src/p1/x.ts": 'export const load = () => eval("require")("./transport")\n' },
    reports: ["generates code at run time (eval)"],
  },
  {
    name: "FA-F34-R4-003: eval(req+uire) loader",
    files: { "functions/src/p1/x.ts": 'export const load = () => eval("req" + "uire")("./transport")\n' },
    reports: ["generates code at run time (eval)"],
  },
  {
    name: "FA-F34-R4-003: (0,eval)(require) loader",
    files: { "functions/src/p1/x.ts": 'export const load = () => (0, eval)("require")("./transport")\n' },
    reports: ["generates code at run time (eval)"],
  },
  {
    name: "FA-F34-R4-003: module.require loader",
    files: { "functions/src/p1/x.ts": "export const load = () => module.require('./transport')\n" },
    reports: ["reaches a module loader through a member"],
  },
  {
    name: "FA-F34-R4-003: import compiled lib transport (unscanned tree)",
    files: { "functions/src/p1/x.ts": 'import { activeTransport } from "../../lib/p1/transport"\nexport const a = activeTransport\n' },
    reports: ["imports functions/lib/p1/transport from an unscanned directory"],
  },
  {
    name: "FA-F34-R3-002: require of transport via lib path (unscanned tree)",
    files: {
      "functions/src/p1/leak.ts": 'export const load = () => require("../../lib/p1/transport").activeTransport\n',
    },
    reports: ["imports functions/lib/p1/transport from an unscanned directory"],
  },
  {
    name: "FA-F34-R5-001: Object.prototype pollution with transport",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        "Object.assign(Object.prototype, { __gw: activeTransport() })\n",
      ),
    },
    reports: ["forbidden environment write"],
  },
  {
    name: "FA-F34-R5-001: defineProperty getter on allowlisted export",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        'Object.defineProperty(callP1, "leak", { get() { return activeTransport() } })\n',
      ),
    },
    reports: ["sealed export mutation"],
  },
  {
    name: "FA-F34-R5-001: allowlisted export return smuggled via as any",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        "export function __r5ReturnAsAny() { return activeTransport() as any }\n",
      ),
    },
    reports: ["export not allowlisted: __r5ReturnAsAny"],
  },
  {
    name: "FA-F34-R5-001: cast transport to number under allowlisted export name",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        "const __wc = activeTransport() as unknown as typeof CALL_WORST_CASE_MS\nvoid __wc\n",
      ),
    },
    reports: ["module-level transport holder"],
  },
  {
    name: "FA-F34-R5-001: namespace merge on parseEvalSet",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'export namespace parseEvalSet { export const leak = 1 }\n',
      ),
    },
    reports: ["namespace merge on sealed export"],
  },
  {
    name: "FA-F34-R5-001: Proxy wrap of seedEvalStore",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'export const seedEvalStore = new Proxy(seedEvalStore, {})\n',
      ),
    },
    reports: ["Proxy wrap of sealed export"],
  },
  {
    name: "FA-F34-R5-001: module-level Map holder without new export name",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        'const __holder = new Map<string, unknown>()\n__holder.set("gw", activeTransport())\n',
      ),
    },
    reports: ["module-level transport holder"],
  },
  {
    name: "FA-F34-R5-001: dynamic globalThis write",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        'globalThis["gw"] = activeTransport()\n',
      ),
    },
    reports: ["forbidden environment write"],
  },
  {
    name: "FA-F34-R5-001: Reflect.defineProperty on globalThis",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        'Reflect.defineProperty(globalThis, "gw", { value: activeTransport() })\n',
      ),
    },
    reports: ["forbidden environment write"],
  },
  {
    name: "FA-F34-R5-001: Object.defineProperties on globalThis",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        "Object.defineProperties(globalThis, { gw: { value: activeTransport() } })\n",
      ),
    },
    reports: ["forbidden environment write"],
  },
  {
    name: "FA-F34-R5-001: Function return this escape",
    files: {
      "functions/src/p1/evalSet.ts": overlayGranted(
        "functions/src/p1/evalSet.ts",
        'const g = Function("return this")()\nvoid g\n',
      ),
    },
    reports: ["Function return this escape"],
  },
  {
    name: "FA-F34-R5-001: process.emit with transport argument",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        'process.emit("leak", activeTransport())\n',
      ),
    },
    reports: ["forbidden environment write"],
  },
  {
    name: "FA-F34-R5-001: opts.cb(transport) callback leak",
    files: {
      "functions/src/p1/gateway.ts": overlayGranted(
        "functions/src/p1/gateway.ts",
        'import type { P1Transport } from "./transport"\nconst __opts = { cb: (_t: P1Transport) => {} }\n__opts.cb(activeTransport()!)\n',
      ),
    },
    reports: ["transport passed as call argument"],
  },
  {
    name: "FA-F34-R5-002: eval string-concat require loader",
    files: { "functions/src/p1/x.ts": 'export const load = () => eval("re" + "quire")("./transport")\n' },
    reports: ["generates code at run time (eval)"],
  },
  {
    name: "FA-F34-R5-002: module bracket require",
    files: { "functions/src/p1/x.ts": 'export const load = () => module["require"]("./transport")\n' },
    reports: ["reaches a module loader through a member"],
  },
  {
    name: "FA-F34-R5-002: require.main.require",
    files: { "functions/src/p1/x.ts": "export const load = () => require.main.require('./transport')\n" },
    reports: ["reaches a module loader through a member (.require)"],
  },
  {
    name: "FA-F34-R5-002: process.mainModule.require",
    files: { "functions/src/p1/x.ts": "export const load = () => process.mainModule.require('./transport')\n" },
    reports: ["reaches a module loader through a member (.mainModule)"],
  },
  {
    name: "FA-F34-R5-002: new Function compiled require",
    files: { "functions/src/p1/x.ts": 'export const load = () => new Function("return require")()("./transport")\n' },
    reports: ["generates code at run time (Function)"],
  },
]

describe("audit F34 R1-003: G-0 [21] p1-transport-import guard (R17)", () => {
  it.each(FAILING)("fails: $name", ({ files, reports }) => {
    const r = run(probe(files))
    for (const report of reports) expect(r.out).toContain(report)
    expect(r.out).toContain("FAIL: a P1 transport is imported outside its grants")
    expect(r.status).toBe(1)
  })

  it("fails: FA-F34-R5-003 symlink transport path alias", () => {
    const dir = probe({
      "functions/src/p1/transport.ts": "export const activeTransport = (): null => null\n",
      "functions/src/p1/leak.ts": 'import { activeTransport } from "./tx"\nexport const t = activeTransport\n',
    })
    fs.symlinkSync(
      path.join(dir, "functions/src/p1/transport.ts"),
      path.join(dir, "functions/src/p1/tx.ts"),
    )
    const r = run(dir)
    expect(r.out).toContain("functions/src/p1/leak.ts: imports activeTransport from functions/src/p1/transport")
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
    [
      "Codex P2 #1: a granted file's own locals derived from the transport, not exported",
      {
        "functions/src/p1/gateway.ts": overlayGranted(
          "functions/src/p1/gateway.ts",
          "async function probeInternalSend(): Promise<void> {\n  const transport = activeTransport()\n  if (transport !== null) await transport.send({ model: 'm', messages: [], maxTokens: 1 })\n}\n",
        ),
      },
    ],
  ])("passes: %s", (_name, files) => {
    const r = run(probe(files as Record<string, string>))
    expect(r.out).toMatch(/PASS: P1 transports are imported only by their grants/)
    expect(r.status).toBe(0)
  })

  it(
    "passes on this repository",
    () => {
      const r = run(repoRoot)
      expect(r.out).toMatch(/PASS: P1 transports are imported only by their grants/)
      expect(r.status).toBe(0)
    },
    120_000,
  )

  it("grants the chat transport to gateway.ts and evalSet.ts, the embedding transport to embedding.ts, and the eval CLI only gatewayTransport and P1Transport", () => {
    const r = run(repoRoot, "--print-grants")
    expect(r.status).toBe(0)
    const printed = JSON.parse(r.out) as { grants: Record<string, Record<string, string[]>>; sendSites: string[] }
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
