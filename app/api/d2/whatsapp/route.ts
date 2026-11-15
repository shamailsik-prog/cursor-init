import { requireIdempotencyKey } from "@/platform/http/idempotency"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { webhookStub } from "@/services/d2-1/transport"
import { handleWhatsAppWebhook } from "@/services/d2-1/webhook"

/**
 * D2-1 signed webhook. Off unless SIKANDER_FLAG_D2_WHATSAPP_GRAMMAR is exactly
 * "true". The HMAC secret is WHATSAPP_APP_SECRET. A present Idempotency-Key is
 * checked with requireIdempotencyKey. There is no phone binding, so the body
 * is not an identity: the handler fail-closes and dedupes raw bytes.
 * The transport is the stub. Nothing here calls a provider.
 */
export async function POST(request: Request): Promise<Response> {
  return handleWhatsAppWebhook(request, {
    transport: webhookStub,
    secret: () => process.env.WHATSAPP_APP_SECRET,
    store: () => getRuntimeStore(),
    requireIdempotencyKey,
  })
}
