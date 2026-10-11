import { classificationRank, type Classification } from "@/platform/p1/types"
import { TRANSPORT_ERROR, type P1Outcome } from "./types"

/**
 * Self-hosted Opik tracing over its REST batch endpoint (spec P3-67). Export is fail-open: it never throws and
 * never fails the call; the caller records the returned status on the usage row.
 */

export const OPIK_TIMEOUT_MS = 2000
const DEFAULT_PROJECT = "sikander-p1"

export type OpikConfig =
  | { enabled: true; baseUrl: string; project: string }
  | { enabled: false; reason: "unset" | "invalid_url" | "unconfirmed" | "third_party_host" }

/** The scheme and host of an http(s) URL without credentials, the host lower-cased and without a trailing dot; null for anything else. */
function httpUrl(raw: string): { https: boolean; host: string } | null {
  try {
    const u = new URL(raw)
    if (u.username !== "" || u.password !== "") return null // fetch refuses a URL with credentials
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    return { https: u.protocol === "https:", host: u.hostname.replace(/\.+$/, "") }
  } catch {
    return null
  }
}

/**
 * A host plain http may reach (M4): loopback (`localhost`, 127.0.0.0/8, `::1`), a private IPv4 literal (10/8,
 * 172.16/12, 192.168/16), or a name ending in `.internal` or `.local`. `URL` has already normalised the host
 * (lower case, IPv4 in dotted decimal, IPv6 compressed in brackets).
 */
function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]" || host.endsWith(".internal") || host.endsWith(".local")) return true
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Enabled only when `OPIK_BASE_URL` is a usable http(s) base, `OPIK_SELF_HOSTED_CONFIRMED` is exactly "true", and
 * the host is not `comet.com` or a subdomain of it (never a third-party cloud). Checked in that order: unset, then
 * invalid_url (unparseable, not http(s), carrying credentials, which fetch refuses, carrying a query or fragment,
 * which would swallow the path appended to it, or plain http to a host that is not loopback, a private IPv4
 * literal or a `.internal` / `.local` name: masked text never crosses a public network in clear), then
 * unconfirmed, then third_party_host.
 */
export function opikConfig(env: NodeJS.ProcessEnv = process.env): OpikConfig {
  const raw = env.OPIK_BASE_URL?.trim()
  if (!raw) return { enabled: false, reason: "unset" }
  const url = httpUrl(raw)
  if (url === null || /[?#]/.test(raw) || (!url.https && !isPrivateHost(url.host))) return { enabled: false, reason: "invalid_url" }
  const { host } = url
  if (env.OPIK_SELF_HOSTED_CONFIRMED !== "true") return { enabled: false, reason: "unconfirmed" }
  if (host === "comet.com" || host.endsWith(".comet.com")) return { enabled: false, reason: "third_party_host" }
  return { enabled: true, baseUrl: raw.replace(/\/+$/, ""), project: env.OPIK_PROJECT_NAME?.trim() || DEFAULT_PROJECT }
}

export type TraceRecord = {
  traceId: string
  startMs: number
  endMs: number
  taskType: string
  classification: Classification
  outcome: P1Outcome
  blockReason: string | null
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  firmId: string
  matterId: string | null
  usageLogId: string
  maskedBody: string | null
  maskedResponse: string | null
}

/**
 * One Opik trace. The masked body and response ride along only at ranks 0 to 3 and never on a blocked call;
 * rank 4 and blocked calls are metadata only. An unknown classification label throws (fails closed).
 */
export function buildTrace(r: TraceRecord, project: string): Record<string, unknown> {
  const trace: Record<string, unknown> = {
    id: r.traceId,
    project_name: project,
    name: `p1.${r.taskType}`,
    start_time: new Date(r.startMs).toISOString(),
    end_time: new Date(r.endMs).toISOString(),
    metadata: {
      classification: r.classification,
      taskType: r.taskType,
      model: r.model,
      provider: r.provider,
      outcome: r.outcome,
      blockReason: r.blockReason,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costMicroUsd: r.costMicroUsd,
      firmId: r.firmId,
      matterId: r.matterId,
      usageLogId: r.usageLogId,
    },
    tags: [r.classification, r.outcome],
  }
  if (classificationRank(r.classification) <= 3 && r.outcome !== "blocked") {
    if (typeof r.maskedBody === "string") trace.input = { prompt: r.maskedBody }
    if (typeof r.maskedResponse === "string") trace.output = { text: r.maskedResponse }
  }
  if (r.outcome === "failed") trace.error_info = { exception_type: TRANSPORT_ERROR, traceback: "" }
  return trace
}

let testFetch: typeof fetch | null = null

/** Test-only. Refused in production, like `platform/p1/internalAICaller.ts`'s `setTransportForTests`. */
export function setOpikFetchForTests(f: typeof fetch | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setOpikFetchForTests is test-only")
  testFetch = f
}

/** Posts one trace; "failed" for any error, non-2xx, refused redirect or timeout, "disabled" when tracing is off. Never throws. */
export async function exportTrace(r: TraceRecord, cfg: OpikConfig = opikConfig(), opts?: { timeoutMs?: number }): Promise<"exported" | "failed" | "disabled"> {
  if (!cfg.enabled) return "disabled"
  try {
    const res = await (testFetch ?? fetch)(`${cfg.baseUrl}/v1/private/traces/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traces: [buildTrace(r, cfg.project)] }),
      // A redirect is refused, never followed: the trace goes to the configured self-hosted base only.
      redirect: "error",
      signal: AbortSignal.timeout(opts?.timeoutMs ?? OPIK_TIMEOUT_MS),
    })
    await res.body?.cancel().catch(() => undefined)
    return res.ok ? "exported" : "failed"
  } catch {
    return "failed"
  }
}
