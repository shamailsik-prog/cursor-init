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
  for (const name of [
    "check_next_ai_egress.py",
    "check_agent_eve_model.ts",
    "check_provider_imports.py",
    "g0_guard_common.py",
    "g0_guard_allowlist.json",
  ]) {
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
  const res = spawnSync("python3", [GATE, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, WORKSPACE_ROOT: repoRoot },
  })
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

const CLEAN = { "app/page.tsx": "export default function Page() { return null }\n" }

type Case = { name: string; files: Record<string, string>; names: string[] }

const CANONICAL_MODEL_MODULE = "platform/p1/committeeBrainModel"

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
    name: "block and line comments between each vi.importActual token (FA-F18-009)",
    files: {
      "app/commented-loader.ts":
        'export const t = vi /* block\ncomment */ . // line\nimportActual /* between method and generic */\n<unknown> // before the call\n( /* before the specifier */\n"@/functions/src/p1/transport")\n',
    },
    names: ["app/commented-loader.ts", "functions/src/p1/transport"],
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
    name: "a Next file importing functions/src/p1/ops (FA-F18-010)",
    files: { "app/api/x/route.ts": 'import { committeeBrainOp } from "@/functions/src/p1/ops"\nexport const op = committeeBrainOp\n' },
    names: ["app/api/x/route.ts", "functions/src/p1/ops"],
  },
  {
    name: "a Next file importing functions/src/p1/reconciler (FA-F18-010)",
    files: { "app/api/x/route.ts": 'import { reconcile } from "@/functions/src/p1/reconciler"\nexport const r = reconcile\n' },
    names: ["app/api/x/route.ts", "functions/src/p1/reconciler"],
  },
  {
    name: "a Next file importing functions/src/p1/evalSet (FA-F18-010)",
    files: { "lib/x.ts": 'import { runLiveEvaluation } from "@/functions/src/p1/evalSet"\nexport const r = runLiveEvaluation\n' },
    names: ["lib/x.ts", "functions/src/p1/evalSet"],
  },
  {
    name: "a Next file importing functions/src/cli/committeeEval (FA-F18-010)",
    files: { "app/api/x/route.ts": 'import { main } from "@/functions/src/cli/committeeEval"\nexport const m = main\n' },
    names: ["app/api/x/route.ts", "functions/src/cli/committeeEval"],
  },
  {
    name: "a Next file importing the compiled functions/lib tree (FA-F18-010)",
    files: { "app/api/x/route.ts": 'import { gatewayTransport } from "@/functions/lib/p1/transport"\nexport const t = gatewayTransport\n' },
    names: ["app/api/x/route.ts", "functions/lib/p1/transport"],
  },
  {
    name: "a Next file importing the Functions HTTP router (FA-F18-010)",
    files: { "app/ok.ts": 'import { ROUTES } from "@/functions/src/http/router"\nexport const r = ROUTES\n' },
    names: ["app/ok.ts", "functions/src/http/router"],
  },
  {
    name: "a specifier that only shares the transport prefix (FA-F18-010)",
    files: { "app/near.ts": 'import { x } from "@/functions/src/p1/transportation"\nexport const t = x\n' },
    names: ["app/near.ts", "functions/src/p1/transportation"],
  },
  {
    name: "a nested type argument on vi.importActual (FA-F18-011)",
    files: {
      "app/nested.ts":
        'export const t = vi.importActual<Record<string, unknown>>("@/functions/src/p1/transport")\n',
    },
    names: ["app/nested.ts", "functions/src/p1/transport"],
  },
  {
    name: "a .envrc that sets a provider key (FA-F18-002)",
    files: { ".envrc": "export AI_GATEWAY_API_KEY=placeholder\n" },
    names: [".envrc", "AI_GATEWAY_API_KEY"],
  },
  {
    name: "a workflow job indented four spaces that binds a key (FA-F18-002)",
    files: {
      ".github/workflows/wide.yml":
        "jobs:\n    web:\n        runs-on: ubuntu-latest\n        env:\n            AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n        steps:\n            - run: npm run build\n",
    },
    names: [".github/workflows/wide.yml", "AI_GATEWAY_API_KEY"],
  },
  {
    name: "an eve model string under agent/ (FA-F18-002)",
    files: { "agent/x.ts": 'export const cfg = { model: "anthropic/claude-sonnet-4.6" }\n' },
    names: ["agent/x.ts", "outside defineAgent"],
  },
  {
    name: "eve shorthand { model } (FA-F18-012)",
    files: { "agent/short.ts": "const model = committeeBrainLanguageModel\nexport const cfg = { model }\n" },
    names: ["agent/short.ts", "outside defineAgent"],
  },
  {
    name: "eve model bound to a string constant (FA-F18-012)",
    files: {
      "agent/const.ts":
        'const GATEWAY = "anthropic/claude-sonnet-4.6"\nexport const cfg = { model: GATEWAY }\n',
    },
    names: ["agent/const.ts", "outside defineAgent"],
  },
  {
    name: "eve model bound to process.env (FA-F18-012)",
    files: { "agent/env.ts": "export const cfg = { model: process.env.EVE_MODEL }\n" },
    names: ["agent/env.ts", "outside defineAgent"],
  },
  {
    name: "eve model via an imported string constant (FA-F18-015)",
    files: {
      "agent/ids.ts": 'export const MODEL = "anthropic/claude-sonnet-4.6"\n',
      "agent/wrap.ts": 'import { MODEL } from "./ids"\nexport const cfg = { model: MODEL }\n',
    },
    names: ["agent/wrap.ts"],
  },
  {
    name: "eve model via a member expression (FA-F18-015)",
    files: {
      "agent/member.ts": 'const MODELS = { sonnet: "anthropic/claude-sonnet-4.6" }\nexport const cfg = { model: MODELS.sonnet }\n',
    },
    names: ["agent/member.ts"],
  },
  {
    name: "eve model via destructured process.env (FA-F18-015)",
    files: {
      "agent/destructure.ts": 'const { EVE_MODEL } = process.env\nexport const cfg = { model: EVE_MODEL }\n',
    },
    names: ["agent/destructure.ts"],
  },
  {
    name: "eve model via a function call (FA-F18-015)",
    files: {
      "agent/call.ts": 'const pickModel = () => "anthropic/claude-sonnet-4.6"\nexport const cfg = { model: pickModel() }\n',
    },
    names: ["agent/call.ts"],
  },
  {
    name: "a key on a workflow job that runs firebase deploy --only hosting (FA-F18-004 M27)",
    files: {
      ".github/workflows/host.yml":
        "jobs:\n  web:\n    runs-on: ubuntu-latest\n    env:\n      AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n    steps:\n      - run: npx firebase deploy --only hosting\n",
    },
    names: [".github/workflows/host.yml", "AI_GATEWAY_API_KEY"],
  },
  {
    name: "FA-F18-016 bypass 1: look-alike agent/committeeBrainModel module",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "./committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "agent/committeeBrainModel.ts": 'export const committeeBrainLanguageModel = "anthropic/claude-sonnet-4.6"\n',
    },
    names: ["agent/agent.ts", CANONICAL_MODEL_MODULE],
  },
  {
    name: "FA-F18-016 bypass 2: real import aliased then local committeeBrainLanguageModel string",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel as brain } from "../platform/p1/committeeBrainModel"\nconst committeeBrainLanguageModel = "anthropic/claude-sonnet-4.6"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", CANONICAL_MODEL_MODULE],
  },
  {
    name: "FA-F18-016 bypass 3: import only in comment plus local committeeBrainLanguageModel string",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\n// import { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nconst committeeBrainLanguageModel = "anthropic/claude-sonnet-4.6"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
    },
    names: ["agent/agent.ts", CANONICAL_MODEL_MODULE],
  },
  {
    name: "FA-F18-016 bypass 4: cfg.model assignment with a quoted Gateway id",
    files: {
      "agent/cfg.ts":
        'const cfg: { model?: string } = {}\ncfg.model = "anthropic/claude-sonnet-4.6"\nexport const x = cfg\n',
    },
    names: ["agent/cfg.ts", "assigning to .model"],
  },
  {
    name: "FA-F18-016 bypass 4b: cfg bracket model assignment",
    files: {
      "agent/cfg2.ts": 'const cfg: Record<string, string> = {}\ncfg["model"] = "anthropic/claude-sonnet-4.6"\nexport const x = cfg\n',
    },
    names: ["agent/cfg2.ts", "computed assignment"],
  },
  {
    name: "FA-F18-016 bypass 5: defineAgent spreads a base built outside agent/",
    files: {
      "lib/agentBase.ts": 'export const base = { model: "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { base } from "../lib/agentBase"\nexport default defineAgent({ ...base, model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "spread"],
  },
  {
    name: "FA-F18-016 bypass 6: shorthand model after let reassignment",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nlet model = committeeBrainLanguageModel\nmodel = "anthropic/claude-sonnet-4.6"\nexport default defineAgent({ model })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "let/var model"],
  },
  {
    name: "FA-F18-016 bypass 6b: shorthand model bound in an inner scope",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nfunction inner() {\n  const model = committeeBrainLanguageModel\n  return { model }\n}\nexport default defineAgent({ model: inner().model })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", CANONICAL_MODEL_MODULE],
  },
  {
    name: "FA-F18-016 bypass 7: one-line JSON model under agent/",
    files: { "agent/eve.json": '{"model":"anthropic/claude-sonnet-4.6"}\n' },
    names: ["agent/eve.json", "anthropic"],
  },
  {
    name: "FA-F18-020a: block shadow on outer model binding",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nconst model = "anthropic/claude-sonnet-4.6"\nif (true) {\n  const model = committeeBrainLanguageModel\n}\nexport default defineAgent({ model })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts"],
  },
  {
    name: "FA-F18-020b: defineAgent via parameter shorthand and a string argument",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nfunction make(model: unknown) {\n  return defineAgent({ model })\n}\nexport default make("anthropic/claude-sonnet-4.6")\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts"],
  },
  {
    name: "FA-F18-020c: destructuring shadow on committeeBrainLanguageModel",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nconst [committeeBrainLanguageModel] = ["anthropic/claude-sonnet-4.6"]\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", CANONICAL_MODEL_MODULE],
  },
  {
    name: "FA-F18-021a: unused defineAgent plus default export from outside agent/",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\ndefineAgent({ model: committeeBrainLanguageModel })\nexport { default } from "../lib/other"\n',
      "lib/other.ts": 'export default { model: "anthropic/claude-sonnet-4.6" }\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts"],
  },
  {
    name: "FA-F18-021b: defineAgent in another file under agent/",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "agent/extra.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport const spare = defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["more than one defineAgent"],
  },
  {
    name: "FA-F18-021c: aliased defineAgent import from eve",
    files: {
      "agent/agent.ts":
        'import { defineAgent as da } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default da({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "defineAgent must be imported by name"],
  },
  {
    name: "FA-F18-022a: Object.defineProperty sets model",
    files: {
      "agent/cfg.ts":
        'const cfg: Record<string, string> = {}\nObject.defineProperty(cfg, "model", { value: "anthropic/claude-sonnet-4.6" })\nexport const x = cfg\n',
    },
    names: ["agent/cfg.ts", "Object.defineProperty"],
  },
  {
    name: "FA-F18-022b: Object.assign sets model",
    files: {
      "agent/cfg.ts":
        'const cfg: Record<string, string> = {}\nObject.assign(cfg, { model: "anthropic/claude-sonnet-4.6" })\nexport const x = cfg\n',
    },
    names: ["agent/cfg.ts", "Object.assign"],
  },
  {
    name: "FA-F18-022c: Reflect.set sets model",
    files: {
      "agent/cfg.ts":
        'const cfg: Record<string, string> = {}\nReflect.set(cfg, "model", "anthropic/claude-sonnet-4.6")\nexport const x = cfg\n',
    },
    names: ["agent/cfg.ts", "Reflect.set"],
  },
  {
    name: "FA-F18-022d: computed bracket assignment with const model key",
    files: {
      "agent/cfg.ts":
        'const cfg: Record<string, string> = {}\nconst k = "model"\ncfg[k] = "anthropic/claude-sonnet-4.6"\nexport const x = cfg\n',
    },
    names: ["agent/cfg.ts", "computed"],
  },
  {
    name: "FA-F18-022e: logical assignment on cfg.model",
    files: {
      "agent/cfg.ts":
        'const cfg: { model?: string } = {}\ncfg.model ||= "anthropic/claude-sonnet-4.6"\nexport const x = cfg\n',
    },
    names: ["agent/cfg.ts", "FA-F18-022"],
  },
  {
    name: "FA-F18-022f: nullish assignment on cfg.model",
    files: {
      "agent/cfg.ts":
        'const cfg: { model?: string } = {}\ncfg.model ??= "anthropic/claude-sonnet-4.6"\nexport const x = cfg\n',
    },
    names: ["agent/cfg.ts", "FA-F18-022"],
  },
  {
    name: "FA-F18-023: quoted model string in agent .mts",
    files: {
      "agent/x.mts": 'export const cfg = { model: "anthropic/claude-sonnet-4.6" }\n',
    },
    names: ["agent/x.mts", "outside defineAgent"],
  },
  {
    name: "FA-F18-025 R1: defineAgent re-exported from a wrapper outside agent/",
    files: {
      "lib/wrap.ts":
        'import { defineAgent as d } from "eve"\nexport const defineAgent = (c: object) => d({ ...c, model: "anthropic/claude-sonnet-4.6" })\n',
      "agent/agent.ts":
        'import { defineAgent } from "../lib/wrap"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "defineAgent must be imported by name"],
  },
  {
    name: "FA-F18-025 R2: namespace eve import and local defineAgent wrapper with outside override spread",
    files: {
      "lib/override.ts": 'export const override = { model: "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import * as eve from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { override } from "../lib/override"\nconst defineAgent = (c: object) => eve.defineAgent({ ...c, ...override })\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-025"],
  },
  {
    name: "FA-F18-025 R3: default eve import and function defineAgent with Object.assign override",
    files: {
      "lib/override.ts": 'export const override = { model: "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import eveDefault from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { override } from "../lib/override"\nfunction defineAgent(c: object) {\n  return (eveDefault as any).defineAgent(Object.assign({}, c, override))\n}\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-025"],
  },
  {
    name: "FA-F18-026: second defineAgent via namespace member call and imported cfg object",
    files: {
      "lib/cfg.ts": 'export const cfg = { model: "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "agent/extra.ts":
        'import * as eve from "eve"\nimport { cfg } from "../lib/cfg"\nexport const spare = eve.defineAgent(cfg)\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/extra.ts", "FA-F18-025"],
  },
  {
    name: "FA-F18-027: Object.assign mutates committeeBrainLanguageModel with an imported evil object",
    files: {
      "lib/evil.ts": 'export const evil = { doGenerate: () => "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { evil } from "../lib/evil"\nObject.assign(committeeBrainLanguageModel, evil)\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-029"],
  },
  {
    name: "FA-F18-028: agent entry is agent.js re-exporting default from outside agent/",
    files: {
      "lib/other.ts": 'export default { model: "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.js": 'export { default } from "../lib/other"\n',
    },
    names: ["agent/agent.ts", "FA-F18-028"],
  },
  {
    name: "FA-F18-029: direct property assignment on committeeBrainLanguageModel",
    files: {
      "lib/evil.ts": 'export const evil = { doGenerate: () => "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { evil } from "../lib/evil"\ncommitteeBrainLanguageModel.doGenerate = evil\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-029"],
  },
  {
    name: "FA-F18-029: computed property assignment on committeeBrainLanguageModel",
    files: {
      "lib/evil.ts": 'export const evil = { doGenerate: () => "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { evil } from "../lib/evil"\ncommitteeBrainLanguageModel["doGenerate"] = evil\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-029"],
  },
  {
    name: "FA-F18-029: alias committeeBrainLanguageModel then mutate through the alias",
    files: {
      "lib/evil.ts": 'export const evil = { doGenerate: () => "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { evil } from "../lib/evil"\nconst m = committeeBrainLanguageModel\nm.doGenerate = evil\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-029"],
  },
  {
    name: "FA-F18-029: Object global aliased then used to mutate committeeBrainLanguageModel",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nconst O = Object\nO.assign(committeeBrainLanguageModel, { doGenerate: () => 1 })\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-029"],
  },
  {
    name: "FA-F18-030: defineAgent.call in a second agent file with imported cfg",
    files: {
      "lib/cfg.ts": 'export const cfg = { model: "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "agent/extra.ts":
        'import { defineAgent } from "eve"\nimport { cfg } from "../lib/cfg"\nexport const spare = defineAgent.call(null, cfg)\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/extra.ts", "FA-F18-030"],
  },
  {
    name: "FA-F18-030: defineAgent assigned to a local then invoked indirectly",
    files: {
      "lib/cfg.ts": 'export const cfg = { model: "anthropic/claude-sonnet-4.6" }\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "agent/sub.ts":
        'import { defineAgent } from "eve"\nimport { cfg } from "../lib/cfg"\nconst f = defineAgent\nexport const spare = f(cfg)\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/sub.ts", "FA-F18-030"],
  },
  {
    name: "FA-F18-031: bare side-effect import pulls in canonical model mutation",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nObject.assign(committeeBrainLanguageModel, { doGenerate: () => "anthropic/claude-sonnet-4.6" })\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport "../lib/patch"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-031"],
  },
  {
    name: "FA-F18-032 q1: named import of a patch module mutates committeeBrainLanguageModel outside agent/",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/patch"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-032 q4: dynamic import of a patch module mutates committeeBrainLanguageModel outside agent/",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nawait import("../lib/patch")\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-033 p7: spare defineAgent outside agent/ re-exported into agent/",
    files: {
      "lib/w.ts":
        'import { defineAgent as d } from "eve"\nexport const spare = d({ model: "anthropic/claude-sonnet-4.6" } as any)\n',
      "agent/x.ts": 'export * from "../lib/w"\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["lib/w.ts", "FA-F18-033"],
  },
  {
    name: "FA-F18-034: patch in lib/p/index.ts reached via import from ../lib/p",
    files: {
      "lib/p/index.ts":
        'import { committeeBrainLanguageModel as m } from "../../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/p"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-034: patch in lib/p/index.ts reached via import from ../lib/p/index",
    files: {
      "lib/p/index.ts":
        'import { committeeBrainLanguageModel as m } from "../../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/p/index"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-035 r2: re-export hop export { x } from ./patch hides canonical mutation",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "lib/a.ts": 'export { x } from "./patch"\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/a"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-035 r3: re-export hop export * from ./patch hides canonical mutation",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "lib/a.ts": 'export * from "./patch"\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/a"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-035 r5: intermediate module dynamic-imports patch then re-exported",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "lib/a.ts": 'await import("./patch"); export const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/a"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-035 r4: patch module loads canonical model via require()",
    files: {
      "lib/patch.ts":
        'const { committeeBrainLanguageModel: m } = require("../platform/p1/committeeBrainModel"); (m as any).doGenerate = () => 1; export const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/patch"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-036 r7: computed require() loads eve outside agent/",
    files: {
      "lib/w.ts":
        'const e = require("e" + "ve"); export const spare = e["define" + "Agent"]({ model: "anthropic/claude-sonnet-4.6" })\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["lib/w.ts", "FA-F18-036"],
  },
  {
    name: "FA-F18-036 r8: computed import() loads eve outside agent/",
    files: {
      "lib/w.ts":
        'const v = "eve"; export const spare = import(`${v}`).then((e: any) => e["define" + "Agent"]({ model: "anthropic/claude-sonnet-4.6" }))\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["lib/w.ts", "FA-F18-036"],
  },
  {
    name: "FA-F18-036 r9: computed require() under agent/ loads eve",
    files: {
      "agent/x.ts":
        'const e = require("e" + "ve"); export const spare = e["define" + "Agent"]({ ["mo" + "del"]: "anthropic/claude-sonnet-4.6" })\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/x.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-037: import cycle poisons closure memo so lib/b hides patch reachability",
    files: {
      "lib/a.ts":
        'import { y } from "./b"; import { x } from "./patch"; void y; void x; export const z = 1\n',
      "lib/b.ts": 'import { z } from "./a"; void z; export const y = 1\n',
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { y } from "../lib/b"; void y\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-038: trailing-slash directory specifier misses lib/p index patch",
    files: {
      "lib/p/index.ts":
        'import { committeeBrainLanguageModel as m } from "../../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/p/"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-039 B6: stored createRequire loads canonical model in patch module",
    files: {
      "lib/patch.ts":
        'import { createRequire } from "node:module"; const req = createRequire(import.meta.url); const { committeeBrainLanguageModel: m } = req("../platform/p1/committeeBrainModel"); (m as any).doGenerate = () => 1; export const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/patch"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-039 B7: stored createRequire loads eve outside agent/",
    files: {
      "lib/w.ts":
        'import { createRequire } from "node:module"; const req = createRequire(import.meta.url); const e = req("eve"); export const spare = e["define" + "Agent"]({ model: "anthropic/claude-sonnet-4.6" })\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["lib/w.ts", "FA-F18-033"],
  },
  {
    name: "FA-F18-039 B8: module.require(\"eve\") outside agent/",
    files: {
      "lib/w.ts":
        'const e = module.require("eve"); export const spare = e["define" + "Agent"]({ model: "anthropic/claude-sonnet-4.6" })\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["lib/w.ts", "FA-F18-033"],
  },
  {
    name: "FA-F18-040: export * from eve outside agent/ re-exported into agent/",
    files: {
      "lib/w.ts": 'export * from "eve"\n',
      "lib/v.ts":
        'import * as E from "./w"; export const spare = (E as any)["define" + "Agent"]({ model: "anthropic/claude-sonnet-4.6" })\n',
      "agent/x.ts": 'export * from "../lib/v"\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["lib/w.ts", "FA-F18-033"],
  },
  {
    name: "FA-F18-041: agent imports patch module from skipped root tests/",
    files: {
      "tests/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../tests/patch"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-041"],
  },
  {
    name: "FA-F18-042: TS import equals require in agent/agent.ts loads patch",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport p = require("../lib/patch"); void p\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-042: TS import equals require hop in lib/a then agent import",
    files: {
      "lib/patch.ts":
        'import { committeeBrainLanguageModel as m } from "../platform/p1/committeeBrainModel";\n(m as any).doGenerate = () => 1;\nexport const x = 1\n',
      "lib/a.ts": 'import p = require("./patch"); void p; export const x = 1\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nimport { x } from "../lib/a"; void x\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["agent/agent.ts", "FA-F18-032"],
  },
  {
    name: "FA-F18-042: TS import equals require(\"eve\") outside agent/",
    files: {
      "lib/w.ts": 'import e = require("eve"); export const spare = e["define" + "Agent"]({ model: "anthropic/claude-sonnet-4.6" })\n',
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: ["lib/w.ts", "FA-F18-033"],
  },
  // FA-D3C-002 (spec R16): the corpus service's embeddings go through P1's p1CorpusEmbedding, so its exemption from
  // rules (a)-(d) is gone (until then this row passed, as "the corpus service (the F27 lane)").
  { name: "the corpus service's env file handing a provider key (FA-D3C-002)", files: { "corpus_service/app.env": "OPENAI_API_KEY=placeholder\n" }, names: ["corpus_service/app.env", "OPENAI_API_KEY"] },
  {
    name: "the corpus service's compose file handing a provider key (FA-D3C-002)",
    files: { "corpus_service/docker-compose.yml": "services:\n  worker-embed:\n    environment:\n      OPENAI_API_KEY: ${OPENAI_API_KEY:-}\n" },
    names: ["corpus_service/docker-compose.yml", "OPENAI_API_KEY"],
  },
  { name: "a provider SDK imported by corpus JS (FA-D3C-002)", files: { "corpus_service/x.ts": 'import OpenAI from "openai"\nexport const c = OpenAI\n' }, names: ["corpus_service/x.ts", "openai"] },
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
    name: "a Next file importing an allowlisted pure Functions module (costTable)",
    files: { "app/ok.ts": 'import { MAX_OUTPUT_TOKENS } from "@/functions/src/p1/costTable"\nexport const n = MAX_OUTPUT_TOKENS\n' },
    names: [],
  },
  {
    name: "eve's model is the P1 LanguageModel identifier, not a string",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: [],
  },
  {
    name: "eve shorthand model bound to the imported P1 LanguageModel (FA-F18-015)",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel as model } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model })\n',
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: [],
  },
  {
    name: "FA-F18-025/027/028 PASS: canonical agent.ts with sandbox and a tool file (no extra defineAgent)",
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve"\nimport { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"\nexport default defineAgent({ model: committeeBrainLanguageModel })\n',
      "agent/sandbox.ts": 'import { defineSandbox } from "eve/sandbox"\nexport default defineSandbox({})\n',
      "agent/tools/x.ts": "export const tool = () => ({ ok: true })\n",
      "platform/p1/committeeBrainModel.ts": "export const committeeBrainLanguageModel = {}\n",
    },
    names: [],
  },
  {
    name: "a Next file importing the F02 router boundary (FA-F18-013)",
    files: {
      "platform/authority/x.ts":
        'import { createF02Router } from "@/functions/src/http/f02RouterBoundary"\nexport const r = createF02Router\n',
    },
    names: [],
  },
  {
    name: "a four-space job that does not build Next, even when it names a key",
    files: {
      ".github/workflows/fn.yml":
        "jobs:\n    fn:\n        env:\n            AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n        steps:\n            - run: npm --prefix functions test\n",
    },
    names: [],
  },
  { name: "the corpus service's P1 settings (FA-D3C-002: a URL and a token file path, no provider key)", files: { "corpus_service/app.env": "P1_EMBEDDING_URL=\nP1_ID_TOKEN_FILE=/run/secrets/p1_id_token\n" }, names: [] },
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
  it("F02 names the router boundary, not the Functions router (FA-F18-013)", () => {
    const src = fs.readFileSync(path.join(repoRoot, "platform/authority/dispatchF02.ts"), "utf8")
    expect(src).not.toContain("functions/src/http/router")
    expect(src).toContain("functions/src/http/f02RouterBoundary")
  })

  it("fails on a symlinked directory under app/ (FA-F18-002)", () => {
    const dir = probe(CLEAN)
    fs.mkdirSync(path.join(dir, "hidden"))
    fs.symlinkSync(path.join(dir, "hidden"), path.join(dir, "app", "linked"), "dir")
    const res = run(dir)
    expect(res.status, res.out).toBe(1)
    expect(res.out).toMatch(/FAIL/)
    expect(res.out).toContain("app/linked")
  })

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
