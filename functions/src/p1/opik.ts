import type { SystemRecord } from "@/platform/p1/outboundPrompt"
import { classificationRank, type Classification } from "@/platform/p1/types"
import { DECISION_RECORD_VERSION } from "./decisionRecord"
import { TRANSPORT_ERROR, type UsageOutcome } from "./types"

/**
 * Self-hosted Opik tracing over its REST batch endpoint (spec P3-67). Export is fail-open: it never throws and
 * never fails the call; the caller records the returned status on the usage row and on the decision record, where a
 * failure stays `pending` until the export reconciler retries it (audit F34, spec ruling R11, traceExport.ts).
 */

export const OPIK_TIMEOUT_MS = 2000

/**
 * The highest classification rank whose masked text may ride in a trace (audit F34, spec ruling R10): 1, so `public` and
 * `internal` only. Confidential (2), privileged (3) and privileged-restricted (4) calls export ids, hashes and metrics
 * only. This supersedes P3-67's ranks 0 to 3: masking removes identifiers, not the substance of a confidential or
 * privileged question, and the trace store is a second system with its own access.
 */
export const TRACE_TEXT_MAX_RANK = 1
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
  /** A call's outcome, or `reconciled` for a trace the export reconciler rebuilds from a reconciled decision record (audit F34). */
  outcome: UsageOutcome
  blockReason: string | null
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  firmId: string
  matterId: string | null
  usageLogId: string
  /** The masked user message as sent. */
  maskedBody: string | null
  /**
   * Which registry policy the system message was (audit F16, spec ruling 4, review round R4a): its id and version, never
   * its text. Absent or null for a record without one.
   */
  system?: SystemRecord | null
  maskedResponse: string | null
  /**
   * Audit F34 (R10): ids and hashes that join the trace to the decision record, at every rank: the prompt hash (never the
   * text), the registered template, and the model the provider reported. Absent on a record built before F34.
   */
  promptHash?: string | null
  promptTemplateId?: string | null
  promptTemplateVersion?: string | null
  modelReported?: string | null
}

/**
 * One Opik trace. The masked request (`{ system, prompt }` with the system policy's id and version, or `{ prompt }`
 * without a system message) and the masked response ride along only at ranks 0 and 1 (TRACE_TEXT_MAX_RANK, audit F34
 * R10) and never on a blocked call; ranks 2 to 4 and blocked calls are metadata only: ids, hashes and metrics. An unknown
 * classification label throws (fails closed).
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
      // Audit F34 (R10): ids and hashes only, never text.
      decisionRecordVersion: DECISION_RECORD_VERSION,
      ...(r.promptHash === undefined ? {} : { promptHash: r.promptHash }),
      ...(r.promptTemplateId === undefined ? {} : { promptTemplateId: r.promptTemplateId }),
      ...(r.promptTemplateVersion === undefined ? {} : { promptTemplateVersion: r.promptTemplateVersion }),
      ...(r.modelReported === undefined ? {} : { modelReported: r.modelReported }),
    },
    tags: [r.classification, r.outcome],
  }
  if (classificationRank(r.classification) <= TRACE_TEXT_MAX_RANK && r.outcome !== "blocked") {
    if (typeof r.maskedBody === "string") trace.input = r.system ? { system: { ...r.system }, prompt: r.maskedBody } : { prompt: r.maskedBody }
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
