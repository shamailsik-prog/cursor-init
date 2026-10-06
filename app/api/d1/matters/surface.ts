import { z } from "zod"
import { SESSION_HEADERS, defineSurface, bodyFieldsOf } from "@/platform/http/surface"
import { classificationField, idField, textField } from "@/platform/http/validation"

/** Request surface of /api/d1/matters (D1-2 matters); see platform/http/surface.ts. */
export const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    actorId: idField,
    firmId: idField,
    clientId: idField,
    title: textField(1000),
    courtId: idField,
    classification: classificationField,
    memberUserIds: z.array(idField).max(200).optional(),
  }),
  z.object({
    action: z.literal("confirm_engagement"),
    actorId: idField,
    matterId: idField,
    atMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    action: z.literal("record_case_number"),
    actorId: idField,
    matterId: idField,
    raw: textField(500),
    courtId: idField,
  }),
])

export const MATTERS_SURFACE = defineSurface({
  views: [],
  actions: Object.keys(bodyFieldsOf(BodySchema)),
  bodyFields: bodyFieldsOf(BodySchema),
  queryParams: ["userId", "limit", "cursor", "actorId", "firmId"],
  headers: SESSION_HEADERS,
})
