import { withIdempotency } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import { handleWhatsApp } from "@/services/d2-1/whatsapp"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    const body = (await request.json()) as { userId?: string; command?: string }
    if (!body.command) throw new Error("command is required")
    const store = getStore()
    return handleWhatsApp(store, body.userId ?? "user_clerk", body.command)
  })
}
