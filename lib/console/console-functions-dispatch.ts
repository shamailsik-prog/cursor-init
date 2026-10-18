import type { ConsoleAuthContext } from "@/lib/console/auth-headers"
import {
  callFunctionsApi,
  committeeBrainViaFunctions,
  type FunctionsCallResult,
  type FunctionsFetch,
} from "@/lib/console/functions-client"

export type ConsoleApiCallOptions = {
  method: "GET" | "POST"
  path: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  idempotencyKey?: string
}

function committeeBrainValidationError(
  code: string,
  message: string
): FunctionsCallResult {
  return {
    ok: false,
    status: 400,
    body: { error: { code, message } },
  }
}

/** Next console paths that are routed to Cloud Functions when a typed route exists. */
export async function tryDispatchConsoleCallToFunctions(
  auth: ConsoleAuthContext,
  options: ConsoleApiCallOptions,
  fetchImpl?: FunctionsFetch
): Promise<FunctionsCallResult | null> {
  if (options.method === "POST" && options.path === "/api/p1/committee-brain") {
    const body = options.body as Record<string, unknown> | undefined
    if (!body || typeof body.body !== "string") {
      return committeeBrainValidationError(
        "invalid_committee_body",
        "committee-brain body must be a string"
      )
    }
    if (typeof body.classification !== "string" || !body.classification.trim()) {
      return committeeBrainValidationError(
        "classification_required",
        "classification is required"
      )
    }
    const classification = body.classification.trim()
    const purpose = typeof body.purpose === "string" ? body.purpose : "ops-audit"
    const partyNames = Array.isArray(body.partyNames)
      ? body.partyNames.filter((n): n is string => typeof n === "string")
      : []
    return committeeBrainViaFunctions(
      auth,
      { body: body.body, classification, purpose, partyNames },
      fetchImpl,
      { idempotencyKey: options.idempotencyKey }
    )
  }

  if (options.method === "GET" && options.path === "/api/d1/clients") {
    const view = options.query?.view
    if (view === undefined || view === "list" || view === "clients") {
      const limit = options.query?.limit
      const cursor = options.query?.cursor
      return callFunctionsApi(auth, {
        method: "GET",
        path: "/api/d1/client/listClients",
        query: {
          firmId: auth.firmId,
          limit: limit !== undefined ? Number(limit) : 20,
          ...(cursor !== undefined && cursor !== "" && cursor !== 0
            ? { cursor: String(cursor) }
            : {}),
        },
        fetchImpl,
      })
    }
    if (view === "client" && options.query?.clientId) {
      return callFunctionsApi(auth, {
        method: "GET",
        path: "/api/d1/client/getClient",
        query: {
          firmId: auth.firmId,
          clientId: String(options.query.clientId),
        },
        fetchImpl,
      })
    }
  }

  return null
}

/** Paths still served only by Next.js (no matching Functions HTTP route in functions/src/http/router.ts). */
export const CONSOLE_NEXT_ONLY_API_PREFIXES = [
  "/api/g0/normalise",
  "/api/d1/matters",
  "/api/d1/documents",
  "/api/d1/document-workflow",
  "/api/d1/reporting",
  "/api/d2/court-ops",
  "/api/d2/ops-reporting",
  "/api/d4/drafts",
  "/api/d4/filings",
  "/api/p5/tenancy",
] as const
