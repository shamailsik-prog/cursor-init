/**
 * Audit F18 (spec docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md, ruling R5): the Next and eve
 * runtime must hold no provider key. Paid calls run only in Cloud Functions P1 (`/api/platform/brain/committeeBrain`),
 * where the kill switches, the budget and the cost log apply; the Next tree has no provider transport at all (R2).
 *
 * A key in this runtime is a deployment error: it means a secret meant for the Functions `api` function reached the Next
 * service or the eve process, where any code that hands the AI SDK a model string (the SDK's default provider reads
 * `AI_GATEWAY_API_KEY` from the environment) would spend outside the control plane. So, under NODE_ENV=production:
 *   - every P1 call is refused with PROVIDER_KEY_IN_RUNTIME_REASON (`checkProviderKeys`), and
 *   - eve refuses to start (`assertNoProviderKeyAtStartup`, called by agent/agent.ts), because eve's framework has model
 *     calls of its own outside the P1 bridge;
 * and in every mode one alert line names the variables, never their values. Outside production nothing is refused: no
 * paid path exists there to refuse, and the test runner and the live evaluations may run with a key in the shell.
 *
 * This is the only runtime file that names provider key variables (G-0 [19], ci_gates/check_next_ai_egress.py, which
 * holds the same list: tests/f18-next-ai-egress-gate.test.ts compares them).
 */

/** Provider API key variables: the AI Gateway pair, and the keys the AI SDK providers and the common provider SDKs read. */
export const PROVIDER_KEY_ENV_NAMES = [
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
] as const

/** The reason a P1 call is refused with, and eve's start-up error. Fixed text: it never names a variable or a value. */
export const PROVIDER_KEY_IN_RUNTIME_REASON =
  "P1: a provider API key is set in this Next or eve runtime; paid calls run only in Cloud Functions P1, so nothing was sent"

/** The alert line's event name (logged at ERROR, so it reaches Cloud Logging and Vercel's log drains). */
export const PROVIDER_KEY_ALERT = "p1.provider_key_in_next_runtime"

/** Where the check ran: the Next committee route, eve's start-up, or an in-process P1 call (route, eve bridge, translate). */
export type ProviderKeyRuntime = "next" | "eve" | "p1-call"

type Env = Record<string, string | undefined>

/** The provider key variables set to a non-blank value, by name. Never returns a value. */
export function providerKeysPresent(env: Env = process.env): string[] {
  return PROVIDER_KEY_ENV_NAMES.filter((name) => (env[name] ?? "").trim() !== "")
}

function alert(runtime: ProviderKeyRuntime, names: string[], refused: boolean): void {
  console.error(`[p1] ALERT ${PROVIDER_KEY_ALERT}`, { runtime, keys: names, refused })
}

export type ProviderKeyCheck = { names: string[]; refuse: boolean }

/**
 * Called on every P1 call in this runtime. With a key present it logs the alert line, and under NODE_ENV=production it
 * tells the caller to refuse.
 */
export function checkProviderKeys(runtime: ProviderKeyRuntime, env: Env = process.env): ProviderKeyCheck {
  const names = providerKeysPresent(env)
  if (names.length === 0) return { names, refuse: false }
  const refuse = env.NODE_ENV === "production"
  alert(runtime, names, refuse)
  return { names, refuse }
}

export class ProviderKeyInRuntimeError extends Error {
  constructor() {
    super(PROVIDER_KEY_IN_RUNTIME_REASON)
    this.name = "ProviderKeyInRuntimeError"
  }
}

/** Start-up check: under NODE_ENV=production a key present refuses to start (throws); otherwise it only alerts. */
export function assertNoProviderKeyAtStartup(runtime: ProviderKeyRuntime, env: Env = process.env): void {
  if (checkProviderKeys(runtime, env).refuse) throw new ProviderKeyInRuntimeError()
}
