import { SESSION_HEADERS, defineSurface } from "@/platform/http/surface"

/** Request surface of /api/d1/reporting (D1-1 client reporting (Module 43)); see platform/http/surface.ts. */
export const REPORTING_SURFACE = defineSurface({
  views: ["search", "matter_report_export_analytics", "matter_report_relevance_snapshots"],
  defaultView: "search",
  actions: ["record_matter_report_export", "recompute_matter_report_relevance"],
  bodyFields: {
    record_matter_report_export: ["action", "actorId", "exportFormat", "exportScope", "matterId", "reason"],
    recompute_matter_report_relevance: ["action", "actorId", "matterId", "provenanceTags", "reason"],
  },
  queryParams: ["view", "actorId", "limit", "cursor", "matterId", "scoreBand", "freshnessStatus", "rowType", "q", "userId", "firmId"],
  headers: SESSION_HEADERS,
})
