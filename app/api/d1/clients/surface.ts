import { z } from "zod"
import { SESSION_HEADERS, defineSurface, bodyFieldsOf } from "@/platform/http/surface"
import { classificationField, idField, textField } from "@/platform/http/validation"

/** Request surface of /api/d1/clients (D1-1 client registry); see platform/http/surface.ts. */
export const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    actorId: idField,
    firmId: idField,
    canonicalName: textField(500),
    cnic: textField(64),
    phone: textField(64),
    classification: classificationField,
  }),
  z.object({
    action: z.literal("conflict_check"),
    actorId: idField,
    firmId: idField,
    entityId: idField,
  }),
])

export const CLIENTS_SURFACE = defineSurface({
  views: [],
  actions: Object.keys(bodyFieldsOf(BodySchema)),
  bodyFields: bodyFieldsOf(BodySchema),
  queryParams: ["userId", "limit", "cursor", "actorId", "firmId"],
  headers: SESSION_HEADERS,
})
