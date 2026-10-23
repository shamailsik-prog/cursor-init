import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import type { Data, FirmOperation } from "../p5/common"
import { checkPermission } from "../p5/permission"
import { HttpError } from "./errors"
import { invokeF02Core } from "@/platform/authority/f02Registry"
import {
  F02_COURT_OPS,
  F02_DOCUMENT_WORKFLOW,
  F02_DOCUMENTS,
  F02_DRAFTS,
  F02_FILINGS,
  F02_MATTERS,
  F02_OPS_REPORTING,
  F02_REPORTING,
  F02_TENANCY,
} from "@/platform/authority/f02Routes"

/**
 * Authority operations for the nine Next domain routes (audit F02).
 *
 * The router has already bound the bearer token and X-Firm-Id. A named matter is
 * refused by checkPermission (current label: cross-firm, not-member, clearance)
 * before the Next core runs. A body classification above the caller's clearance
 * is refused here so the client cannot raise it. The matters list is filtered
 * again on the way out: list_matters allows a member, and the core's membership
 * filter does not apply clearance.
 *
 * The core stays in the Next process. These routes are not HTTP-forwarded: the
 * deployed function has no Next core (503 authority_core_unconfigured), and
 * document bodies exceed the default 1 MB cap. Next calls createRouter in-process.
 */

const DEFAULT_UPLOAD_BYTES = 25 * 1024 * 1024
const DRAFTS_MAX_BODY_BYTES = 2 * 1024 * 1024
const CODE = /^[a-z][a-z0-9_]{0,63}$/

/** Same ceiling as platform/http/validation.ts maxUploadRequestBytes, read per request. */
function documentsMaxBodyBytes(): number {
  const raw = process.env.SIKANDER_MAX_UPLOAD_BYTES
  const parsed = raw === undefined ? DEFAULT_UPLOAD_BYTES : Number(raw)
  const max = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_UPLOAD_BYTES
  return Math.ceil(((max * 4) / 3) * 1.06) + 64 * 1024
}

function matterIdOf(data: Data): string | undefined {
  const raw = data.matterId
  return typeof raw === "string" && raw !== "" ? raw : undefined
}

/** F02 clearance and classification gate. Runs before the Next core. */
async function enforceMatterAndClassification(caller: Caller, data: Data): Promise<void> {
  const matterId = matterIdOf(data)
  if (matterId) {
    const decision = await checkPermission(caller, "matter.read", matterId)
    if (!decision.allow) {
      if (decision.reason === "audit_unavailable") throw new HttpError(503, "audit_unavailable")
      throw new HttpError(403, decision.reason.replaceAll("-", "_"))
    }
  }
  const classification = data.classification
  if (isKnownClassification(classification) && rankOf(classification) > rankOf(caller.clearanceLevel)) {
    throw new HttpError(403, "exceeds_own_clearance")
  }
}

function visibleTo(caller: Caller, item: unknown): boolean {
  if (!item || typeof item !== "object") return true
  const classification = (item as { classification?: unknown }).classification
  if (classification === undefined) return true
  if (!isKnownClassification(classification)) return false
  return rankOf(caller.clearanceLevel) >= rankOf(classification)
}

/**
 * Drops matters the caller is not cleared for. `total` shrinks by the rows removed
 * from this page only; a later page is not re-counted. Items with no classification
 * field are kept. An unknown label is fail-closed.
 */
function filterMatterPage(caller: Caller, body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const record = body as { items?: unknown; total?: unknown }
  if (!Array.isArray(record.items)) return body
  const items = record.items.filter((item) => visibleTo(caller, item))
  const dropped = record.items.length - items.length
  if (dropped === 0) return body
  const total = typeof record.total === "number" ? Math.max(0, record.total - dropped) : items.length
  return { ...record, items, total }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function errorCodeOf(body: unknown, status: number): string {
  if (isPlainObject(body)) {
    if (typeof body.code === "string" && CODE.test(body.code)) return body.code
    if (typeof body.error === "string" && CODE.test(body.error)) return body.error
    if (isPlainObject(body.error) && typeof body.error.code === "string" && CODE.test(body.error.code)) {
      return body.error.code
    }
  }
  if (status === 400) return "invalid_request"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 409) return "conflict"
  if (status === 413) return "payload_too_large"
  return "request_failed"
}

async function callCore(path: string, method: "GET" | "POST"): Promise<Response> {
  try {
    return await invokeF02Core(path, method)
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (err instanceof Error && err.message === "authority_core_unconfigured") {
      throw new HttpError(503, "authority_core_unconfigured")
    }
    throw new HttpError(500, "internal")
  }
}

function f02Op(path: string, method: "GET" | "POST"): FirmOperation {
  return {
    auth: "firm",
    kind: "general",
    action: "f02.authority",
    target: path,
    run: async ({ caller }, data, audit) => {
      audit.firmId = caller.firmId
      audit.target = path
      await enforceMatterAndClassification(caller, data)
      const response = await callCore(path, method)
      const payload = await readPayload(response)
      if (response.status >= 200 && response.status < 300) {
        const body = path === F02_MATTERS && method === "GET" ? filterMatterPage(caller, payload) : payload
        await audit.allow()
        return isPlainObject(body) ? body : { result: body }
      }
      throw new HttpError(response.status, errorCodeOf(payload, response.status))
    },
  }
}

type AuthorityRoute = {
  method: "GET" | "POST"
  path: string
  handler: FirmOperation
  kind: "general"
  /**
   * `rerun`: the domain write is the Next core's, fenced by beginIdempotentRequest.
   * A Functions `once` marker cannot wrap that write, and audit.allow() does not
   * stage one. The key is still required, and a stored 2xx is replayed.
   */
  idempotency?: "rerun"
  maxBodyBytes?: number | (() => number)
}

const get = (path: string): AuthorityRoute => ({ method: "GET", path, handler: f02Op(path, "GET"), kind: "general" })
const post = (path: string, maxBodyBytes?: number | (() => number)): AuthorityRoute => ({
  method: "POST",
  path,
  handler: f02Op(path, "POST"),
  kind: "general",
  idempotency: "rerun",
  ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
})

export const F02_NEXT_AUTHORITY_ROUTES: readonly AuthorityRoute[] = [
  get(F02_MATTERS),
  post(F02_MATTERS),
  get(F02_DOCUMENTS),
  post(F02_DOCUMENTS, documentsMaxBodyBytes),
  get(F02_DOCUMENT_WORKFLOW),
  post(F02_DOCUMENT_WORKFLOW),
  get(F02_REPORTING),
  post(F02_REPORTING),
  get(F02_COURT_OPS),
  post(F02_COURT_OPS),
  get(F02_OPS_REPORTING),
  post(F02_OPS_REPORTING),
  get(F02_DRAFTS),
  post(F02_DRAFTS, DRAFTS_MAX_BODY_BYTES),
  get(F02_FILINGS),
  post(F02_FILINGS),
  get(F02_TENANCY),
  post(F02_TENANCY),
]
