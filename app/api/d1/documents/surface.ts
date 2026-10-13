import { z } from "zod"
import { SESSION_HEADERS, defineSurface, bodyFieldsOf } from "@/platform/http/surface"
import { classificationField, idField, base64Field } from "@/platform/http/validation"

/** Request surface of /api/d1/documents (D3-1 document vault read path and D1-6 ingest); see platform/http/surface.ts. */
export const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ingest"),
    actorId: idField,
    firmId: idField,
    matterId: idField.nullable().optional(),
    contentBase64: base64Field,
    sourceChannel: z.enum(["web", "team_portal", "whatsapp", "bulk"]),
    mimeType: z.string().min(1).max(256).optional(),
    // Optional: an unlabelled upload defaults to privileged (L17.3), floored at the matter.
    classification: classificationField.optional(),
  }),
])

export const DOCUMENTS_SURFACE = defineSurface({
  views: [],
  actions: Object.keys(bodyFieldsOf(BodySchema)),
  bodyFields: bodyFieldsOf(BodySchema),
  queryParams: ["userId", "matterId", "limit", "cursor", "actorId", "firmId", "docId", "includeContent"],
  headers: SESSION_HEADERS,
})
