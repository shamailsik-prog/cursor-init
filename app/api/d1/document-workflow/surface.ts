import { z } from "zod"
import { SESSION_HEADERS, defineSurface, bodyFieldsOf } from "@/platform/http/surface"
import { classificationField, idField } from "@/platform/http/validation"

/** Request surface of /api/d1/document-workflow (D3-1 document review workflow); see platform/http/surface.ts. */
export const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("transition"),
    actorId: idField,
    documentId: idField,
    nextStatus: z.enum(["queued", "processing", "review_required", "complete"]),
    reason: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("assign_reviewer"),
    actorId: idField,
    documentId: idField,
    reviewerId: idField,
  }),
  z.object({
    action: z.literal("review_decision"),
    actorId: idField,
    documentId: idField,
    decision: z.enum(["confirm_classification", "declassify"]),
    nextClassification: classificationField.optional(),
    reason: z.string().max(2000).optional(),
  }),
])

export const DOCUMENT_WORKFLOW_SURFACE = defineSurface({
  views: ["queue", "timeline"],
  defaultView: "queue",
  actions: Object.keys(bodyFieldsOf(BodySchema)),
  bodyFields: bodyFieldsOf(BodySchema),
  queryParams: ["view", "userId", "matterId", "limit", "cursor", "status", "actorId", "firmId"],
  headers: SESSION_HEADERS,
})
