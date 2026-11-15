import { createHmac, timingSafeEqual } from "node:crypto"
import type { SpineStore } from "@/platform/spine/store"
import { dispatchWhatsApp, resetD2WhatsAppThreadsForTests, type WhatsAppDispatch } from "./dispatch"
import { D2_WHATSAPP_GRAMMAR_FLAG, isD2WhatsAppGrammarEnabled } from "./grammar"
import { webhookStub, type WhatsAppTransport } from "./transport"

/**
 * Inbound WhatsApp webhook. The secret is read from the env name
 * WHATSAPP_APP_SECRET only. Callers pass that value in; this module does not
 * log it. Message ids are the dedupe key. The transport is the stub.
 */

const SIGNATURE_HEADER = "X-Hub-Signature-256"
const DEDUPE_LIMIT = 1000

type Cached = { status: number; body: unknown }

const seen = new Map<string, Cached>()

export function resetD2WhatsAppWebhookForTests(): void {
  seen.clear()
  webhookStub.sent.length = 0
  resetD2WhatsAppThreadsForTests()
}

export type WebhookDeps = {
  store: () => SpineStore
  transport: WhatsAppTransport
  secret: () => string | undefined
  now?: number
  requireIdempotencyKey?: (request: Request) => string
  readResearch?: (query: string) => Promise<{ title: string }[]>
  execute?: (store: SpineStore, userId: string, text: string) => Promise<WhatsAppDispatch>
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function signaturesMatch(secret: string, raw: string, header: string | null): boolean {
  if (!header) return false
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
  const left = Buffer.from(expected)
  const right = Buffer.from(header.trim())
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)
}

function statusOf(result: WhatsAppDispatch): number {
  if (result.ok) return 200
  if (result.denied) return 403
  return 400
}

export async function handleWhatsAppWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (!isD2WhatsAppGrammarEnabled()) {
    return json(403, { error: "whatsapp_channel_disabled", flag: D2_WHATSAPP_GRAMMAR_FLAG })
  }

  const secret = deps.secret()
  if (!secret) return json(401, { error: "webhook_not_configured" })

  const raw = await request.text()
  if (!signaturesMatch(secret, raw, request.headers.get(SIGNATURE_HEADER))) {
    return json(401, { error: "bad_signature" })
  }

  if (request.headers.get("Idempotency-Key")) {
    try {
      deps.requireIdempotencyKey?.(request)
    } catch {
      return json(400, { error: "invalid_idempotency_key" })
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw) as unknown
  } catch {
    return json(400, { error: "invalid_json" })
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json(400, { error: "invalid_message" })
  }
  const record = payload as Record<string, unknown>
  const messageId = record.messageId
  const userId = record.userId
  const text = record.text
  if (!isToken(messageId) || !isToken(userId) || typeof text !== "string" || text.length === 0 || text.length > 2000) {
    return json(400, { error: "invalid_message" })
  }

  const cached = seen.get(messageId)
  if (cached) return json(cached.status, cached.body)

  const store = deps.store()
  const result = deps.execute
    ? await deps.execute(store, userId, text)
    : await dispatchWhatsApp(store, userId, text, { now: deps.now, readResearch: deps.readResearch })
  const sent = await deps.transport.send({ toUserId: userId, text: result.text })
  const body = {
    ok: result.ok,
    denied: result.denied === true,
    error: result.error,
    command: result.command,
    result,
    transport: sent.transport,
  }
  const status = statusOf(result)
  if (seen.size >= DEDUPE_LIMIT) {
    const oldest = seen.keys().next().value
    if (oldest) seen.delete(oldest)
  }
  seen.set(messageId, { status, body })
  return json(status, body)
}
