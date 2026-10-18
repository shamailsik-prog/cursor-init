import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Audit F18, G-0 check [19] (ci_gates/check_next_ai_egress.py; spec ruling R9): nothing in the Next or eve runtime can
 * make a paid AI call outside the Cloud Functions P1 control plane. Each case plants one thing into a temporary tree that
 * holds only the gate scripts, runs the gate there, and expects it to fail and name what it found, or to pass. The last
 * cases run it on this repository: it passes on the cleaned tree. On main it fails there (platform/p1/gatewayTransport.ts
 * imports the `ai` SDK and names the keys; .env.example offers them as settings).
 *
 * Key-shaped values never appear here: every planted value is an obviously fake placeholder.
 */

const repoRoot = process.cwd()
const GATE = "ci_gates/check_next_ai_egress.py"
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function probe(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f18-gate-"))
  tmpDirs.push(dir)
  fs.mkdirSync(path.join(dir, "ci_gates"), { recursive: true })
  for (const name of ["check_next_ai_egress.py", "check_provider_imports.py", "g0_guard_common.py", "g0_guard_allowlist.json"]) {
    const src = path.join(repoRoot, "ci_gates", name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, "ci_gates", name))
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

const CLEAN = { "app/page.tsx": "export default function Page() { return null }\n" }

type Case = { name: string; files: Record<string, string>; names: string[] }

const FAILING: Case[] = [
  { name: "the ai SDK's generateText in a Next route", files: { "app/api/x/route.ts": 'import { generateText } from "ai"\nexport const f = generateText\n' }, names: ["app/api/x/route.ts", "ai"] },
  { name: "a type-only import from ai (the package is the paid client)", files: { "lib/x.ts": 'import type { LanguageModel } from "ai"\nexport type M = LanguageModel\n' }, names: ["lib/x.ts", "ai"] },
  { name: "the AI Gateway provider package", files: { "platform/p1/gw.ts": 'import { createGateway } from "@ai-sdk/gateway"\nexport const g = createGateway\n' }, names: ["platform/p1/gw.ts", "@ai-sdk/gateway"] },
  { name: "a provider SDK under platform/p1 (no prefix is exempt in the Next runtime)", files: { "platform/p1/x.ts": 'import OpenAI from "openai"\nexport const c = OpenAI\n' }, names: ["platform/p1/x.ts", "openai"] },
  { name: "a dynamic import of an AI SDK provider in an eve tool", files: { "agent/tools/x.ts": 'export const load = () => import("@ai-sdk/anthropic")\n' }, names: ["agent/tools/x.ts", "@ai-sdk/anthropic"] },
  { name: "require of ai in a script", files: { "scripts/x.cjs": 'const { generateText } = require("ai")\nmodule.exports = generateText\n' }, names: ["scripts/x.cjs", "ai"] },
  { name: "the provider-utils package (it carries fetch helpers)", files: { "lib/y.ts": 'import { postJsonToApi } from "@ai-sdk/provider-utils"\nexport const p = postJsonToApi\n' }, names: ["lib/y.ts", "@ai-sdk/provider-utils"] },
  { name: "reading the AI Gateway key", files: { "lib/key.ts": "export const k = process.env.AI_GATEWAY_API_KEY\n" }, names: ["lib/key.ts", "AI_GATEWAY_API_KEY"] },
  { name: "reading a provider key by index", files: { "services/k.ts": 'export const k = process.env["OPENAI_API_KEY"]\n' }, names: ["services/k.ts", "OPENAI_API_KEY"] },
  { name: "a provider key named in console text", files: { "components/c.tsx": "export const C = () => <p>set VERCEL_AI_GATEWAY_API_KEY</p>\n" }, names: ["components/c.tsx", "VERCEL_AI_GATEWAY_API_KEY"] },
  { name: "a provider API host in a fetch", files: { "components/f.tsx": 'export const go = () => fetch("https://api.openai.com/v1/chat/completions")\n' }, names: ["components/f.tsx", "api.openai.com"] },
  { name: "the AI Gateway host in a constant", files: { "lib/h.ts": 'export const U = "https://ai-gateway.vercel.sh/v1/chat/completions"\n' }, names: ["lib/h.ts", "ai-gateway.vercel.sh"] },
  { name: "a commented key template in the Next env example", files: { ".env.example": "# Optional live path\n# AI_GATEWAY_API_KEY=\n" }, names: [".env.example", "AI_GATEWAY_API_KEY"] },
  { name: "a key in a Next env file", files: { ".env.production": "OPENAI_API_KEY=placeholder\n" }, names: [".env.production", "OPENAI_API_KEY"] },
  { name: "a key bound in an App Hosting config", files: { "apphosting.yaml": "env:\n  - variable: AI_GATEWAY_API_KEY\n    secret: placeholderSecretName\n" }, names: ["apphosting.yaml", "AI_GATEWAY_API_KEY"] },
  {
    name: "a key passed to a workflow job that builds the Next app",
    files: { ".github/workflows/deploy.yml": "jobs:\n  web:\n    runs-on: ubuntu-latest\n    env:\n      AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n    steps:\n      - run: npm run build\n" },
    names: [".github/workflows/deploy.yml", "AI_GATEWAY_API_KEY"],
  },
  {
    name: "a workflow-level key above a job that deploys the app",
    files: { ".github/workflows/ship.yml": "env:\n  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\njobs:\n  ship:\n    steps:\n      - run: npx firebase deploy --only apphosting\n" },
    names: [".github/workflows/ship.yml", "OPENAI_API_KEY"],
  },
  { name: "a key in a Dockerfile", files: { Dockerfile: "FROM node:22\nARG ANTHROPIC_API_KEY\n" }, names: ["Dockerfile", "ANTHROPIC_API_KEY"] },
  { name: "a key in vercel.json", files: { "vercel.json": '{ "env": { "AI_GATEWAY_API_KEY": "@placeholder" } }\n' }, names: ["vercel.json", "AI_GATEWAY_API_KEY"] },
]

const PASSING: Case[] = [
  { name: "type-only imports from @ai-sdk/provider (types and error classes, no network code)", files: { "platform/p1/m.ts": 'import type { LanguageModelV3 } from "@ai-sdk/provider"\nexport type M = LanguageModelV3\n' }, names: [] },
  { name: "the runtime key guard, the one file that names the keys", files: { "platform/p1/providerKeyGuard.ts": 'export const NAMES = ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY"]\n' }, names: [] },
  { name: "the Functions control plane (governed by G-0 [3])", files: { "functions/src/p1/transport.ts": 'export const URL = "https://ai-gateway.vercel.sh/v1/chat/completions"\nexport const k = process.env.AI_GATEWAY_API_KEY\n', "functions/.env": "AI_GATEWAY_API_KEY=\n" }, names: [] },
  { name: "the corpus service (the F27 lane; FA-D3C-002 under G-0 [3])", files: { "corpus_service/app.env": "OPENAI_API_KEY=placeholder\n", "corpus_service/x.ts": 'import OpenAI from "openai"\n' }, names: [] },
  { name: "the root test suite", files: { "tests/x.test.ts": 'import { generateText } from "ai"\nexport const g = generateText\n' }, names: [] },
  { name: "prose in an env example that names a key without setting it", files: { ".env.example": "# Never set AI_GATEWAY_API_KEY in the Next or eve runtime.\n" }, names: [] },
  { name: "a YAML comment that names a key", files: { ".github/workflows/ci.yml": "# AI_GATEWAY_API_KEY is bound only to the Functions api function\njobs: {}\n" }, names: [] },
  {
    name: "the coding-agent workflow handing ANTHROPIC_API_KEY to claude-code-action (CI tooling, not the Next/eve runtime)",
    files: {
      ".github/workflows/agent.yml":
        "jobs:\n  continue:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n        with:\n          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}\n  web:\n    steps:\n      - run: npm run build\n",
    },
    names: [],
  },
]

describe("audit F18: G-0 [19] next-ai-egress guard", () => {
  it("passes a clean tree", () => {
    const res = run(probe(CLEAN))
    expect(res.out).toMatch(/PASS/)
    expect(res.status).toBe(0)
  })

  it.each(FAILING.map((c) => [c.name, c] as const))("fails on %s", (_name, c) => {
    const res = run(probe({ ...CLEAN, ...c.files }))
    expect(res.status, res.out).toBe(1)
    expect(res.out).toMatch(/FAIL/)
    for (const name of c.names) expect(res.out).toContain(name)
  })

  it.each(PASSING.map((c) => [c.name, c] as const))("passes %s", (_name, c) => {
    const res = run(probe({ ...CLEAN, ...c.files }))
    expect(res.status, res.out).toBe(0)
  })

  it("passes on this repository", () => {
    const res = run(repoRoot)
    expect(res.status, res.out).toBe(0)
    expect(res.out).toMatch(/PASS/)
  })

  it("lists the same provider key names as the runtime guard (platform/p1/providerKeyGuard.ts)", async () => {
    const res = run(repoRoot, "--print-key-names")
    expect(res.status, res.out).toBe(0)
    const gateNames = JSON.parse(res.out) as string[]
    const guard = (await import("@/platform/p1/providerKeyGuard").catch(() => null)) as { PROVIDER_KEY_ENV_NAMES?: readonly string[] } | null
    expect(guard?.PROVIDER_KEY_ENV_NAMES, "the runtime guard exists").toBeDefined()
    expect([...gateNames].sort()).toEqual([...(guard!.PROVIDER_KEY_ENV_NAMES ?? [])].sort())
  })

  it("is G-0 check [19]", () => {
    const g0 = fs.readFileSync(path.join(repoRoot, "ci_gates", "gate_g0.sh"), "utf8")
    expect(g0).toMatch(/\[19\][^\n]*\n[^\n]*python3 ci_gates\/check_next_ai_egress\.py \|\| fail=1/)
  })
})

/**
 * Audit F18 re-audit follow-up (spec section "Re-audit follow-up": FA-F18-001a, FA-F18-002, FA-F18-004). The auditor's
 * attacks (gate_attack.py P12, P17, P27, P33, P35-P37, P39, P40) and the surviving gate mutants (M2, M27, M31), as named
 * cases.
 *
 * Planted bodies that carry a module specifier are built by the helpers below, and the runtime marker by `MARKER`, so
 * this file's own source never holds a literal import of a Functions module or the marker: the new rule scans tests/
 * too, and would otherwise read a planted body as this file importing it.
 */
const importOf = (spec: string, name = "activeTransport") => `import { ${name} } from "${spec}"\nexport const use_${name} = ${name}\n`
const exportFrom = (spec: string) => `export { activeTransport } from "${spec}"\n`
const requireOf = (spec: string) => `const t = require("${spec}")\nmodule.exports = t\n`
const dynamicImportOf = (spec: string) => `export const load = () => import("${spec}")\n`
const importActualOf = (spec: string) => `import { vi } from "vitest"\nexport const load = () => vi.importActual("${spec}")\n`
const mockOf = (spec: string) => `import { vi } from "vitest"\nvi.mock("${spec}", () => ({ activeTransport: () => null }))\n`
/** The compile-time constant functions/build.mjs defines in the Functions bundles (spec ruling R13). */
const MARKER = ["__SIKANDER", "FUNCTIONS_RUNTIME__"].join("_")

const FUNCTIONS_STUB: Record<string, string> = {
  "functions/src/p1/transport.ts": "export const activeTransport = () => null\nexport const gatewayTransport = () => null\n",
  "functions/src/p1/gateway.ts": "export const callP1 = () => null\n",
  "functions/src/p1/costTable.ts": "export const MAX_OUTPUT_TOKENS = 4096\n",
  "functions/src/p5/auth.ts": "export const bindHttpSession = () => null\n",
}

const WF4 =
  "on: push\njobs:\n    web:\n        runs-on: ubuntu-latest\n        env:\n            AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n        steps:\n            - run: npm run build\n"

const FAILING_FU: Case[] = [
  {
    name: "P17: a Next route importing the Functions P1 transport through @/",
    files: { ...FUNCTIONS_STUB, "app/api/y/route.ts": importOf("@/functions/src/p1/transport") },
    names: ["app/api/y/route.ts", "functions/src/p1/transport"],
  },
  {
    name: "a relative import of the Functions gateway from platform/",
    files: { ...FUNCTIONS_STUB, "platform/p1/x.ts": importOf("../../functions/src/p1/gateway", "callP1") },
    names: ["platform/p1/x.ts", "functions/src/p1/gateway"],
  },
  { name: "require() of the Functions transport in a script", files: { ...FUNCTIONS_STUB, "scripts/x.cjs": requireOf("../functions/src/p1/transport") }, names: ["scripts/x.cjs", "functions/src/p1/transport"] },
  { name: "a dynamic import() of the Functions gateway", files: { ...FUNCTIONS_STUB, "lib/load.ts": dynamicImportOf("@/functions/src/p1/gateway") }, names: ["lib/load.ts", "functions/src/p1/gateway"] },
  { name: "an export-from of the Functions transport with its .ts extension", files: { ...FUNCTIONS_STUB, "lib/re.ts": exportFrom("../functions/src/p1/transport.ts") }, names: ["lib/re.ts", "functions/src/p1/transport"] },
  {
    name: "a tsconfig paths alias (comments and trailing commas included) that resolves into functions/",
    files: {
      ...FUNCTIONS_STUB,
      "tsconfig.json": '{\n  // the Functions tree, by another name\n  "compilerOptions": { "baseUrl": ".", "paths": { "#fn/*": ["./functions/*"], }, },\n}\n',
      "lib/a.ts": importOf("#fn/src/p1/transport"),
    },
    names: ["lib/a.ts", "functions/src/p1/transport"],
  },
  { name: "a bare functions/ specifier (resolved from the tsconfig baseUrl)", files: { ...FUNCTIONS_STUB, "components/c.tsx": importOf("functions/src/p1/transport") }, names: ["components/c.tsx", "functions/src/p1/transport"] },
  { name: "a root test file importing the Functions transport (never allowlisted)", files: { ...FUNCTIONS_STUB, "tests/x.test.ts": importOf("@/functions/src/p1/transport") }, names: ["tests/x.test.ts", "functions/src/p1/transport"] },
  {
    name: "a test helper importing a pure Functions module that is not on the allowlist",
    files: { ...FUNCTIONS_STUB, "tests/helpers/y.ts": importOf("@/functions/src/p1/costTable", "MAX_OUTPUT_TOKENS") },
    names: ["tests/helpers/y.ts", "functions/src/p1/costTable"],
  },
  { name: "vi.importActual of the Functions transport in a test", files: { ...FUNCTIONS_STUB, "tests/z.test.ts": importActualOf("@/functions/src/p1/transport") }, names: ["tests/z.test.ts", "functions/src/p1/transport"] },
  {
    name: "an allowlisted importer reaching a module its entry does not name",
    files: {
      ...FUNCTIONS_STUB,
      "tests/p5.identity-policy.parity.test.ts": importOf("../functions/src/p5/auth", "bindHttpSession") + importOf("../functions/src/p1/transport"),
    },
    names: ["tests/p5.identity-policy.parity.test.ts", "functions/src/p1/transport"],
  },
  {
    name: "a stale allowlist entry (the allowlisted file no longer imports its module)",
    files: { ...FUNCTIONS_STUB, "tests/p5.identity-policy.parity.test.ts": "export const parity = true\n" },
    names: ["tests/p5.identity-policy.parity.test.ts", "stale", "functions/src/p5/auth"],
  },
  {
    name: "P12: a tsconfig paths alias to the ai package in node_modules",
    files: { "tsconfig.json": '{"compilerOptions":{"paths":{"llm":["./node_modules/ai"]}}}\n', "lib/a.ts": importOf("llm", "generateText") },
    names: ["lib/a.ts: imports ai"],
  },
  { name: "P27: a workflow indented four spaces that builds the app with a key", files: { ".github/workflows/w4.yml": WF4 }, names: [".github/workflows/w4.yml", "AI_GATEWAY_API_KEY"] },
  {
    name: "a workflow indented one space that builds the app with a key",
    files: { ".github/workflows/w1.yml": "jobs:\n web:\n  env:\n   OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n  steps:\n   - run: npm run build\n" },
    names: [".github/workflows/w1.yml", "OPENAI_API_KEY"],
  },
  {
    name: "a four-space workflow whose second job builds the app with a key",
    files: {
      ".github/workflows/w2.yml":
        "jobs:\n    fn:\n        steps:\n            - run: npm --prefix functions test\n    web:\n        env:\n            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n        steps:\n            - run: npx next build\n",
    },
    names: [".github/workflows/w2.yml", "ANTHROPIC_API_KEY"],
  },
  { name: "P33: .envrc (direnv) exporting a key", files: { ".envrc": "export AI_GATEWAY_API_KEY=placeholder\n" }, names: [".envrc", "AI_GATEWAY_API_KEY"] },
  {
    name: "P39: a new eve agent file with a Gateway model string",
    files: { "agent/agent2.ts": 'import { defineAgent } from "eve"\nexport default defineAgent({ model: "anthropic/claude-sonnet-4.6" })\n' },
    names: ["agent/agent2.ts", "anthropic/claude-sonnet-4.6"],
  },
  { name: "a template-literal model string in an eve tool", files: { "agent/tools/sub.ts": "export const cfg = { model: `openai/gpt-5` }\n" }, names: ["agent/tools/sub.ts", "openai/gpt-5"] },
  { name: "a model in an eve skill's front matter", files: { "agent/skills/x.md": "---\nname: x\nmodel: anthropic/claude-haiku-4.5\n---\nDo the thing.\n" }, names: ["agent/skills/x.md", "anthropic/claude-haiku-4.5"] },
  { name: "P35: @anthropic-ai/vertex-sdk", files: { "lib/v.ts": importOf("@anthropic-ai/vertex-sdk", "AnthropicVertex") }, names: ["lib/v.ts: imports @anthropic-ai/vertex-sdk"] },
  { name: "P36: @aws-sdk/client-bedrock-agent-runtime", files: { "lib/b.ts": importOf("@aws-sdk/client-bedrock-agent-runtime", "BedrockAgentRuntimeClient") }, names: ["lib/b.ts: imports @aws-sdk/client-bedrock-agent-runtime"] },
  { name: "P37: @langchain/openai", files: { "lib/l.ts": importOf("@langchain/openai", "ChatOpenAI") }, names: ["lib/l.ts: imports @langchain/openai"] },
  { name: "@langchain/anthropic", files: { "lib/l2.ts": importOf("@langchain/anthropic", "ChatAnthropic") }, names: ["lib/l2.ts: imports @langchain/anthropic"] },
  {
    name: "M27: a key handed to a job that runs firebase deploy --only hosting",
    files: { ".github/workflows/f.yml": "jobs:\n  web:\n    env:\n      AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n    steps:\n      - run: npx firebase deploy --only hosting\n" },
    names: [".github/workflows/f.yml", "AI_GATEWAY_API_KEY"],
  },
  { name: "M31: a platform/ file other than the guard naming a provider key", files: { "platform/p1/other.ts": "export const k = process.env.AI_GATEWAY_API_KEY\n" }, names: ["platform/p1/other.ts", "AI_GATEWAY_API_KEY"] },
  { name: "the Functions runtime marker set outside functions/", files: { "lib/m.ts": `;(globalThis as Record<string, unknown>).${MARKER} = true\n` }, names: ["lib/m.ts", MARKER] },
  { name: "the Functions runtime marker set in a root test", files: { "tests/m.test.ts": `;(globalThis as Record<string, unknown>).${MARKER} = true\n` }, names: ["tests/m.test.ts", MARKER] },
]

const PASSING_FU: Case[] = [
  { name: "an allowlisted parity test importing the pure Functions module its entry names", files: { ...FUNCTIONS_STUB, "tests/p5.identity-policy.parity.test.ts": importOf("../functions/src/p5/auth", "bindHttpSession") }, names: [] },
  {
    name: "Functions code importing Functions and platform code (the control plane itself)",
    files: { ...FUNCTIONS_STUB, "functions/src/x.ts": importOf("./p1/transport") + importOf("@/platform/p1/types", "isClassification") },
    names: [],
  },
  {
    name: "eve's agent with the P1 LanguageModel, an identifier",
    files: { "agent/agent.ts": 'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n' },
    names: [],
  },
  {
    name: "a four-space workflow whose only key goes to the Functions tests",
    files: {
      ".github/workflows/fn.yml":
        "jobs:\n    fn:\n        env:\n            AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n        steps:\n            - run: npm --prefix functions test\n    web:\n        steps:\n            - run: npm run build\n",
    },
    names: [],
  },
  { name: "a path string that names a Functions file without importing it", files: { "lib/s.ts": 'export const PATH = "functions/src/p1/transport.ts"\n' }, names: [] },
  { name: "the firebase-functions npm package (not the functions/ tree)", files: { "lib/f.ts": importOf("firebase-functions", "logger") }, names: [] },
  { name: "a directory named functions somewhere else", files: { "lib/functions/x.ts": "export const x = 1\n", "lib/y.ts": importOf("./functions/x", "x") }, names: [] },
  { name: "vi.mock of a Functions module with a factory (a replacement; nothing of it loads)", files: { ...FUNCTIONS_STUB, "tests/w.test.ts": mockOf("@/functions/src/p1/transport") }, names: [] },
]

/** The provider key variables, pinned (M2: a name dropped from both lists at once must fail a test). */
const PINNED_KEY_NAMES = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "TOGETHER_AI_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY",
  "REPLICATE_API_TOKEN",
  "ELEVENLABS_API_KEY",
  "DEEPL_AUTH_KEY",
]

const ALLOWLIST_ANCHOR = "FUNCTIONS_IMPORT_ALLOWLIST: dict[tuple[str, str], str] = {\n"

describe("audit F18 re-audit follow-up: [19] closes the Functions import path and the deploy-surface gaps", () => {
  it.each(FAILING_FU.map((c) => [c.name, c] as const))("fails on %s", (_name, c) => {
    const res = run(probe({ ...CLEAN, ...c.files }))
    expect(res.status, res.out).toBe(1)
    expect(res.out).toMatch(/FAIL/)
    for (const name of c.names) expect(res.out).toContain(name)
  })

  it.each(PASSING_FU.map((c) => [c.name, c] as const))("passes %s", (_name, c) => {
    const res = run(probe({ ...CLEAN, ...c.files }))
    expect(res.status, res.out).toBe(0)
  })

  it("P40: refuses a symlinked directory instead of skipping what is behind it", () => {
    const dir = probe(CLEAN)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "f18-gate-outside-"))
    tmpDirs.push(outside)
    fs.writeFileSync(path.join(outside, "llm.ts"), importOf("ai", "generateText"))
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true })
    fs.symlinkSync(outside, path.join(dir, "lib", "vendor"), "dir")
    const res = run(dir)
    expect(res.status, res.out).toBe(1)
    expect(res.out).toContain("lib/vendor")
  })

  it("M2: the gate and the runtime guard both hold exactly the pinned key names", async () => {
    const res = run(repoRoot, "--print-key-names")
    expect(res.status, res.out).toBe(0)
    expect(JSON.parse(res.out)).toEqual(PINNED_KEY_NAMES)
    const guard = (await import("@/platform/p1/providerKeyGuard").catch(() => null)) as { PROVIDER_KEY_ENV_NAMES?: readonly string[] } | null
    expect([...(guard?.PROVIDER_KEY_ENV_NAMES ?? [])]).toEqual(PINNED_KEY_NAMES)
  })

  it("prints its Functions import allowlist: test importers only, never the transport or the gateway, each with a reason", () => {
    const res = run(repoRoot, "--print-functions-allowlist")
    expect(res.status, res.out).toBe(0)
    const entries = JSON.parse(res.out) as { importer: string; module: string; reason: string }[]
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.importer, JSON.stringify(e)).toMatch(/^tests\//)
      expect(e.module, JSON.stringify(e)).toMatch(/^functions\//)
      expect(["functions/src/p1/transport", "functions/src/p1/gateway"]).not.toContain(e.module)
      expect(e.reason.length, JSON.stringify(e)).toBeGreaterThan(10)
      expect(fs.existsSync(path.join(repoRoot, e.importer)), e.importer).toBe(true)
    }
  })

  it.each(["functions/src/p1/transport", "functions/src/p1/gateway"])("fails when its allowlist names %s, whatever the reason", (module) => {
    const dir = probe(CLEAN)
    const gate = path.join(dir, GATE)
    const src = fs.readFileSync(gate, "utf8")
    expect(src.includes(ALLOWLIST_ANCHOR), "the gate keeps its allowlist in FUNCTIONS_IMPORT_ALLOWLIST").toBe(true)
    fs.writeFileSync(gate, src.replace(ALLOWLIST_ANCHOR, `${ALLOWLIST_ANCHOR}    ("tests/x.test.ts", "${module}"): "a planted entry with a long enough reason",\n`))
    const res = run(dir)
    expect(res.status, res.out).toBe(1)
    expect(res.out).toMatch(new RegExp(`allowlist.*${module.replace(/\//g, "\\/")}`))
  })
})
