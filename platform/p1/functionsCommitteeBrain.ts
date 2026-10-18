/**
 * Audit F18 (spec docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md, rulings R1, R4, R6, R7, R8):
 * the Next side's one client for committee work. It sends a committee request to the canonical P1 entry point, Cloud
 * Functions `POST /api/platform/brain/committeeBrain`, where the ID token is verified and bound to the firm, `ai.call`
 * is checked on the matter, and the kill switches, the budget reservation, the cost log and the alerts apply. It talks to
 * our own Functions API only; it never names or reaches a provider.
 *
 * - The caller's own `Authorization` header (the ID token the Next session already verified), the session's firm as
 *   `X-Firm-Id` and the request's own `Idempotency-Key` are sent, so Functions decides as that caller, and a same-key retry
 *   converges on Functions' own idempotency fence (F09) instead of dispatching twice.
 * - Redirects are refused (`redirect: "error"`): the bearer token goes to the configured host only.
 * - The forward times out at FORWARD_TIMEOUT_MS (the `api` function's 120 s timeout plus 5 s).
 * - When Functions does not answer, or answers a 2xx that is not a committee answer, the result is a fail-closed `failed`
 *   outcome with one alert line (FORWARD_ALERT), and the caller answers 502, 503 or 504 with no local fallback.
 */
import type { Classification } from "@/platform/p1/types"

export const FUNCTIONS_COMMITTEE_BRAIN_PATH = "/api/platform/brain/committeeBrain"

/**
 * The `api` function's timeout (functions/src/health.ts FUNCTION_TIMEOUT_SECONDS, 120 s) plus 5 s, so Next normally
 * outwaits Functions. The committee route's `maxDuration` (130 s) sits above this, so the platform never cuts the
 * request off before the forward's own deadline (PR #88 review round 1). A Functions answer that still lands after Next
 * gave up (a cold start or a slow network before Functions starts its clock) is paid once and stored under the same
 * Idempotency-Key (F09), and a same-key retry gets it: tests/f18-legacy-ai-path.e2e.firestore.test.ts row (k).
 */
export const FORWARD_TIMEOUT_MS = 125_000

let forwardTimeoutForTests: number | null = null

/** Test seam only: a shorter forward deadline. Refused in production; production code never sets it. */
export function setForwardTimeoutForTests(ms: number | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setForwardTimeoutForTests is test-only")
  forwardTimeoutForTests = ms
}

/** Alert line when a configured Functions P1 route does not answer usably. */
export const FORWARD_ALERT = "p1.next_forward_failed"

/** Alert line, in production, when no usable Functions base URL is configured. */
export const FUNCTIONS_NOT_CONFIGURED_ALERT = "p1.next_functions_not_configured"

/** The region the `api` function deploys to (functions/src/http/router.ts), for the emulator's URL. */
const FUNCTIONS_REGION = "asia-south1"

type Env = Record<string, string | undefined>

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "localhost" || h === "::1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** The URL when it is usable for a bearer token: https, or http to a loopback host; no credentials, query or fragment. */
function usableBase(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null
  if (raw.includes("?") || raw.includes("#")) return null
  return url.href.replace(/\/+$/, "")
}

/**
 * The Functions `api` base URL the forward appends `/api/...` to, the same convention as the console's
 * (lib/console/functions-emulator-url.ts): `SIKANDER_FUNCTIONS_API_BASE_URL`, else
 * `NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL`, else the Functions emulator host, never under NODE_ENV=production (as
 * the session refuses the Auth emulator there, F01). Null when none is set or the one set is not usable (R8).
 */
export function functionsP1BaseUrl(env: Env = process.env): string | null {
  const explicit = env.SIKANDER_FUNCTIONS_API_BASE_URL?.trim() || env.NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL?.trim()
  if (explicit) return usableBase(explicit)
  if (env.NODE_ENV === "production") return null
  const emulator = env.FIREBASE_FUNCTIONS_EMULATOR_HOST?.trim() || env.FUNCTIONS_EMULATOR_HOST?.trim()
  if (!emulator) return null
  const host = emulator.replace(/^https?:\/\//, "")
  const project = env.GCLOUD_PROJECT?.trim() || env.FIREBASE_PROJECT_ID?.trim() || "demo-sikander"
  return usableBase(`http://${host}/${project}/${FUNCTIONS_REGION}/api`)
}

/** What the Functions committeeBrain route takes (functions/src/p1/ops.ts parseCommitteeInput); never `documentIds`. */
export type CommitteePayload = {
  matterId: string
  body: string
  purpose: string
  classification: Classification
  partyNames: string[]
}

export type ForwardRequest = {
  /** The incoming request's own `Authorization` header, verbatim. */
  authorization: string
  firmId: string
  idempotencyKey: string
  payload: CommitteePayload
}

export type ForwardOutcome =
  /** Functions answered with a committee answer (its body as given). */
  | { kind: "answer"; body: Record<string, unknown> }
  /** Functions refused (any non-2xx): relayed with its status and code. */
  | { kind: "refused"; status: number; code: string; retryAfter?: string }
  /** Functions did not answer usably: fail closed, no local fallback (R4). */
  | { kind: "failed"; status: 502 | 503 | 504; code: "p1_functions_unavailable" | "p1_functions_timeout" | "p1_functions_bad_answer" }

function failed(status: 502 | 503 | 504, code: "p1_functions_unavailable" | "p1_functions_timeout" | "p1_functions_bad_answer"): ForwardOutcome {
  console.error(`[p1] ALERT ${FORWARD_ALERT}`, { code, route: FUNCTIONS_COMMITTEE_BRAIN_PATH })
  return { kind: "failed", status, code }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A committee answer: what committeeBrainOp returns, at least its output id and whether it was blocked. */
function isCommitteeAnswer(value: unknown): value is Record<string, unknown> {
  return isObject(value) && typeof value.outputId === "string" && value.outputId !== "" && typeof value.blocked === "boolean"
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === "TimeoutError" || name === "AbortError"
}

/** Error codes as the router answers them (`{ error: { code } }`): a short identifier, else a fixed code. */
function errorCodeOf(body: unknown): string {
  const code = isObject(body) && isObject(body.error) ? body.error.code : undefined
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "p1_functions_error"
}

export async function forwardCommitteeBrain(
  baseUrl: string,
  request: ForwardRequest,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<ForwardOutcome> {
  const fetchFn = deps.fetch ?? globalThis.fetch
  let res: Response
  try {
    res = await fetchFn(`${baseUrl}${FUNCTIONS_COMMITTEE_BRAIN_PATH}`, {
      method: "POST",
      headers: {
        authorization: request.authorization,
        "x-firm-id": request.firmId,
        "idempotency-key": request.idempotencyKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(request.payload),
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? forwardTimeoutForTests ?? FORWARD_TIMEOUT_MS),
    })
  } catch (err) {
    return isTimeout(err) ? failed(504, "p1_functions_timeout") : failed(503, "p1_functions_unavailable")
  }
  let body: unknown
  try {
    const text = await res.text()
    body = text === "" ? null : (JSON.parse(text) as unknown)
  } catch (err) {
    if (isTimeout(err)) return failed(504, "p1_functions_timeout")
    body = undefined
  }
  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after") ?? undefined
    return { kind: "refused", status: res.status, code: errorCodeOf(body), ...(retryAfter ? { retryAfter } : {}) }
  }
  if (!isCommitteeAnswer(body)) return failed(502, "p1_functions_bad_answer")
  return { kind: "answer", body }
}
