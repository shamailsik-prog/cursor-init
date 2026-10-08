// Filings core-request predicate (Erratum E-24), moved out of routeGate.ts unchanged so the G-2
// routes that import routeGate (the D1 routes, final review I3) do not import a query read.

/**
 * The live core of /api/d4/filings while LEGACY_GOVERNANCE_CHAINS is off: the v6
 * Module 12 package path that the existing tests cover (tests/api.filings.test.ts
 * "creates pending filing package and supports partner approval", "lists filing
 * packages with pagination and matter scoping", "filters filing packages by
 * readiness after partner approval", "blocks filing package creation when
 * preflight overruled gate fails"):
 *   POST action create_package (incl. the citation gate, the session-bound partnerOverride
 *        and its audit, the draft charset refusal, the stored judgment ids and the draft lock)
 *   POST action decide_package (partner approval, incl. the bodySha256 check against the
 *        durable draft, the judgment-id re-check at approval, the override audit and the
 *        draft lock/unlock)
 *   GET  the package list (no `view`, or view=packages)
 * fix/sec-gaps added no filings action or view: every approval-path check it added runs
 * inside these two actions, so the core list is unchanged.
 * Everything else (dispatch queue, annexures, submission/transport, escalation,
 * closure and settlement chains) is frozen.
 */
export const FILINGS_CORE_ACTIONS: readonly string[] = ["create_package", "decide_package"]
export const FILINGS_CORE_VIEWS: readonly string[] = ["packages"]

export async function isFilingsCoreRequest(request: Request): Promise<boolean> {
  if (request.method.toUpperCase() === "GET") {
    const view = new URL(request.url).searchParams.get("view")
    return !view || FILINGS_CORE_VIEWS.includes(view)
  }
  let action: unknown
  try {
    action = ((await request.clone().json()) as { action?: unknown } | null)?.action
  } catch {
    action = undefined
  }
  // No usable action: the handler's own validation answers (400) before any data is read.
  if (typeof action !== "string" || action === "") return true
  return FILINGS_CORE_ACTIONS.includes(action)
}
