import { SESSION_HEADERS, defineSurface } from "@/platform/http/surface"
import { WHATSAPP_COMMANDS } from "@/services/d2-1/whatsapp"

/** Request surface of /api/d2/court-ops (D2-1 WhatsApp commands and the D6-1 court-ops queue); see platform/http/surface.ts. */
export const COURT_OPS_SURFACE = defineSurface({
  views: [],
  actions: ["whatsapp_command", "acknowledge_item", "resolve_follow_up", "resolve_workflow"],
  bodyFields: {
    whatsapp_command: ["action", "actorId", "command"],
    acknowledge_item: ["action", "actorId", "id", "queueType", "reason"],
    resolve_follow_up: ["action", "actorId", "followUpId", "reason"],
    resolve_workflow: ["action", "actorId", "documentId", "nextStatus", "reason"],
  },
  queryParams: ["userId", "matterId", "limit", "cursor", "actorId", "firmId"],
  headers: SESSION_HEADERS,
  commands: WHATSAPP_COMMANDS.map((c) => c.name),
})
