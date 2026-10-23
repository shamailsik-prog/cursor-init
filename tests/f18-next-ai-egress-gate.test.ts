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
  {
    name: "a Next route importing the Functions P1 transport through the @/ alias",
    files: { "app/api/x/route.ts": 'import { activeTransport } from "@/functions/src/p1/transport"\nexport const t = activeTransport\n' },
    names: ["app/api/x/route.ts", "functions/src/p1/transport"],
  },
  {
    name: "a type-only import of the Functions P1 transport (the module is the paid client)",
    files: { "lib/x.ts": 'import type { P1Transport } from "@/functions/src/p1/transport"\nexport type T = P1Transport\n' },
    names: ["lib/x.ts", "functions/src/p1/transport"],
  },
  {
    name: "an export-from of the Functions P1 transport, extension included",
    files: { "lib/re.ts": 'export { gatewayTransport } from "@/functions/src/p1/transport.ts"\n' },
    names: ["lib/re.ts", "functions/src/p1/transport"],
  },
  {
    name: "a dynamic import of the Functions P1 transport",
    files: { "app/api/x/route.ts": 'export const load = () => import("@/functions/src/p1/transport")\n' },
    names: ["app/api/x/route.ts", "functions/src/p1/transport"],
  },
  {
    name: "a dynamic import of the Functions P1 gateway with a query",
    files: { "services/x.ts": 'export const load = () => import("@/functions/src/p1/gateway?paid")\n' },
    names: ["services/x.ts", "functions/src/p1/gateway"],
  },
  {
    name: "require of the Functions P1 gateway",
    files: { "scripts/x.cjs": 'const { callP1 } = require("@/functions/src/p1/gateway")\nmodule.exports = callP1\n' },
    names: ["scripts/x.cjs", "functions/src/p1/gateway"],
  },
  {
    name: "require.resolve of the Functions P1 transport",
    files: { "scripts/y.cjs": 'module.exports = require.resolve("@/functions/src/p1/transport")\n' },
    names: ["scripts/y.cjs", "functions/src/p1/transport"],
  },
  {
    name: "a relative import of the Functions P1 transport from a Next route",
    files: { "app/api/x/route.ts": 'import { activeTransport } from "../../../functions/src/p1/transport"\nexport const t = activeTransport\n' },
    names: ["app/api/x/route.ts", "functions/src/p1/transport"],
  },
  {
    name: "a relative dynamic import of the Functions P1 gateway",
    files: { "lib/a/b.ts": 'export const load = () => import("../../functions/src/p1/gateway.js")\n' },
    names: ["lib/a/b.ts", "functions/src/p1/gateway"],
  },
  {
    name: "a comment between the import tokens of the Functions P1 transport",
    files: { "components/c.tsx": 'import { activeTransport } from /* paid */ "@/functions/src/p1/transport"\nexport const t = activeTransport\n' },
    names: ["components/c.tsx", "functions/src/p1/transport"],
  },
  {
    name: "a multiline import of the Functions P1 gateway",
    files: { "platform/x.ts": 'import {\n  callP1,\n} from "@/functions/src/p1/gateway"\nexport const c = callP1\n' },
    names: ["platform/x.ts", "functions/src/p1/gateway"],
  },
  {
    name: "a bare functions/src/p1/transport specifier",
    files: { "app/y.ts": 'import { activeTransport } from "functions/src/p1/transport"\nexport const t = activeTransport\n' },
    names: ["app/y.ts", "functions/src/p1/transport"],
  },
  {
    name: "an index path of the Functions P1 transport",
    files: { "app/z.ts": 'import { activeTransport } from "@/functions/src/p1/transport/index.ts"\nexport const t = activeTransport\n' },
    names: ["app/z.ts", "functions/src/p1/transport"],
  },
  {
    name: "createRequire loading the Functions P1 transport",
    files: {
      "lib/cr.ts":
        'import { createRequire } from "node:module"\nconst req = createRequire(import.meta.url)\nexport const t = req("@/functions/src/p1/transport")\n',
    },
    names: ["lib/cr.ts", "functions/src/p1/transport"],
  },
  {
    name: "createRequire called at once for the Functions P1 gateway",
    files: {
      "lib/cr2.ts":
        'import { createRequire } from "node:module"\nexport const t = createRequire(import.meta.url)("@/functions/src/p1/gateway")\n',
    },
    names: ["lib/cr2.ts", "functions/src/p1/gateway"],
  },
  {
    name: "vi.importActual of the Functions P1 transport",
    files: { "app/v.ts": 'export const t = vi.importActual("@/functions/src/p1/transport")\n' },
    names: ["app/v.ts", "functions/src/p1/transport"],
  },
  {
    name: "jest.requireActual of the Functions P1 gateway",
    files: { "app/j.ts": 'export const t = jest.requireActual<unknown>("@/functions/src/p1/gateway")\n' },
    names: ["app/j.ts", "functions/src/p1/gateway"],
  },
  {
    name: "the corpus service importing the Functions P1 transport",
    files: { "corpus_service/x.ts": 'import { activeTransport } from "@/functions/src/p1/transport"\nexport const t = activeTransport\n' },
    names: ["corpus_service/x.ts", "functions/src/p1/transport"],
  },
  {
    name: "a platform/p1 file other than the key guard naming a provider key (FA-F18-004 M31)",
    files: { "platform/p1/other.ts": "export const k = process.env.OPENAI_API_KEY\n" },
    names: ["platform/p1/other.ts", "OPENAI_API_KEY"],
  },
  {
    name: "a key on a workflow job that runs firebase deploy --only hosting (FA-F18-004 M27)",
    files: {
      ".github/workflows/host.yml":
        "jobs:\n  web:\n    runs-on: ubuntu-latest\n    env:\n      AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n    steps:\n      - run: npx firebase deploy --only hosting\n",
    },
    names: [".github/workflows/host.yml", "AI_GATEWAY_API_KEY"],
  },
]

const PASSING: Case[] = [
  { name: "type-only imports from @ai-sdk/provider (types and error classes, no network code)", files: { "platform/p1/m.ts": 'import type { LanguageModelV3 } from "@ai-sdk/provider"\nexport type M = LanguageModelV3\n' }, names: [] },
  { name: "the runtime key guard, the one file that names the keys", files: { "platform/p1/providerKeyGuard.ts": 'export const NAMES = ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY"]\n' }, names: [] },
  { name: "the Functions control plane (governed by G-0 [3])", files: { "functions/src/p1/transport.ts": 'export const URL = "https://ai-gateway.vercel.sh/v1/chat/completions"\nexport const k = process.env.AI_GATEWAY_API_KEY\n', "functions/.env": "AI_GATEWAY_API_KEY=\n" }, names: [] },
  {
    name: "a Functions file importing its own transport",
    files: { "functions/src/p1/gateway.ts": 'import { activeTransport } from "./transport"\nexport const t = activeTransport\n' },
    names: [],
  },
  {
    name: "a Next file importing a Functions module that is not the transport or the gateway",
    files: {
      "app/ok.ts":
        'import { MAX_OUTPUT_TOKENS } from "@/functions/src/p1/costTable"\nimport { ROUTES } from "@/functions/src/http/router"\nexport const n = MAX_OUTPUT_TOKENS\nexport const r = ROUTES\n',
    },
    names: [],
  },
  {
    name: "a specifier that only shares the transport prefix",
    files: { "app/near.ts": 'import { x } from "@/functions/src/p1/transportation"\nexport const t = x\n' },
    names: [],
  },
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
    // FA-F18-004 M2: parity alone survives dropping a name from both lists. The list is pinned.
    expect(gateNames).toEqual([
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
    ])
  })

  it("is G-0 check [19]", () => {
    const g0 = fs.readFileSync(path.join(repoRoot, "ci_gates", "gate_g0.sh"), "utf8")
    expect(g0).toMatch(/\[19\][^\n]*\n[^\n]*python3 ci_gates\/check_next_ai_egress\.py \|\| fail=1/)
  })
})
