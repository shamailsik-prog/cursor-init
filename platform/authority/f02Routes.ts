/**
 * The nine Next.js domain routes that still called Admin Firestore from the route
 * handler (issue #30, F02). `/api/g0/normalise` is not in this set: it has no
 * domain repository. The ops console still requests these paths on Next; in
 * production Firestore mode the route delegates to the in-process Functions router.
 */
export const F02_MATTERS = "/api/d1/matters"
export const F02_DOCUMENTS = "/api/d1/documents"
export const F02_DOCUMENT_WORKFLOW = "/api/d1/document-workflow"
export const F02_REPORTING = "/api/d1/reporting"
export const F02_COURT_OPS = "/api/d2/court-ops"
export const F02_OPS_REPORTING = "/api/d2/ops-reporting"
export const F02_DRAFTS = "/api/d4/drafts"
export const F02_FILINGS = "/api/d4/filings"
export const F02_TENANCY = "/api/p5/tenancy"

export const F02_ROUTE_PATHS = [
  F02_MATTERS,
  F02_DOCUMENTS,
  F02_DOCUMENT_WORKFLOW,
  F02_REPORTING,
  F02_COURT_OPS,
  F02_OPS_REPORTING,
  F02_DRAFTS,
  F02_FILINGS,
  F02_TENANCY,
] as const

export type F02RoutePath = (typeof F02_ROUTE_PATHS)[number]
export type F02Method = "GET" | "POST"

/** Response header set only after the Functions router has handled the call. */
export const F02_AUTHORITY_HEADER = "x-authority-path"
export const F02_AUTHORITY_VALUE = "functions"
