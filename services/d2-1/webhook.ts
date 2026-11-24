import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { AuditEntry, SpineStore } from "@/platform/spine/store"
import { resetD2WhatsAppThreadsForTests, type WhatsAppDispatch } from "./dispatch"
import { D2_WHATSAPP_GRAMMAR_FLAG, isD2WhatsAppGrammarEnabled } from "./grammar"
import {
  openWhatsAppOutboundKeyStore,
  resetWhatsAppOutboundKeyStoreForTests,
  sendWhatsAppOnce,
  UNBOUND_OUTBOUND_FIRM,
  type OutboundKeyStore,
} from "./outboundKeys"
import { webhookStub, type WhatsAppTransport } from "./transport"

/**
 * Inbound WhatsApp webhook. The secret is read from the env name
 * WHATSAPP_APP_SECRET only. Callers pass that value in; this module does not
 * log it. There is no phone-to-user binding, so a signed body is never an
 * identity: every command fail-closes with "not linked" and the HTTP body is
 * only { ok }. Dedupe is the unbound sender plus a hash of the raw bytes.
 * The transport is the stub.
 */

const SIGNATURE_HEADER = "X-Hub-Signature-256"
const DEDUPE_LIMIT = 1000
const IN_FLIGHT = 0

export const WHATSAPP_BODY_CAP_BYTES = 8192
export const WHATSAPP_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
export const WHATSAPP_PROCESSING_TIMEOUT_MS = 5_000
export const WHATSAPP_READ_DEADLINE_MS = 5_000
export const WHATSAPP_SECRET_MIN_BYTES = 32
export const WHATSAPP_NOT_LINKED_TEXT = "not linked"

/**
 * Padding that does not make a secret. Removed before the 32-byte UTF-8 count:
 * default-ignorable code points (Hangul fillers, variation selectors, tags),
 * format characters, combining marks, and Unicode white space. trim() still
 * refuses a secret it would change, so a leading space is not a secret.
 */
const SECRET_PADDING = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\p{White_Space}]/gu

type Cached = { status: number; body: { ok: false } }

type Slot = {
  promise: Promise<Cached>
  /** 0 while the delivery is in flight. A positive value is the expiry. */
  expiresAt: number
}

const seen = new Map<string, Slot>()
const settled: string[] = []

export function resetD2WhatsAppWebhookForTests(): void {
  seen.clear()
  settled.length = 0
  webhookStub.reset()
  resetD2WhatsAppThreadsForTests()
  resetWhatsAppOutboundKeyStoreForTests()
}

export type WebhookDeps = {
  store: () => SpineStore
  transport: WhatsAppTransport
  secret: () => string | undefined
  now?: number
  requireIdempotencyKey?: (request: Request) => string
  readResearch?: (query: string) => Promise<{ title: string }[]>
  /** Ignored. Identity is not taken from the body, so nothing is dispatched. */
  execute?: (store: SpineStore, userId: string, text: string) => Promise<WhatsAppDispatch>
  /** Ignored. No permission decision is made until a phone is linked. */
  persistAudit?: (rows: readonly AuditEntry[]) => Promise<void>
  /**
   * Durable outbound keys. Omitted uses the process store (memory, or Firestore
   * when SIKANDER_PERSISTENCE_MODE=firestore). A transport that ignores keys
   * still cannot send a live key twice.
   */
  outboundKeys?: OutboundKeyStore
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function secretUsable(secret: string | undefined): secret is string {
  if (typeof secret !== "string" || secret.length === 0 || secret !== secret.trim()) return false
  const substantive = secret.replace(SECRET_PADDING, "")
  return substantive.length > 0 && Buffer.byteLength(substantive) >= WHATSAPP_SECRET_MIN_BYTES
}

function signaturesMatch(secret: string, raw: Buffer, header: string | null): boolean {
  if (!header) return false
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
  const left = Buffer.from(expected)
  const right = Buffer.from(header.trim())
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function payloadKey(raw: Buffer): string {
  return `unbound\0${createHash("sha256").update(raw).digest("hex")}`
}

function withTimeout<T>(pending: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error("whatsapp_timeout"))
    }, ms)
    pending.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

function drop(key: string): void {
  seen.delete(key)
  const at = settled.indexOf(key)
  if (at >= 0) settled.splice(at, 1)
}

function keepSettled(key: string): void {
  settled.push(key)
  while (settled.length > DEDUPE_LIMIT) {
    const oldest = settled.shift()
    if (oldest) seen.delete(oldest)
  }
}

function reserve(key: string, now: number): { wait: Promise<Cached> } | { settle: (cached: Cached, retain: boolean) => void } {
  const existing = seen.get(key)
  if (existing && existing.expiresAt !== IN_FLIGHT && existing.expiresAt <= now) drop(key)
  const current = seen.get(key)
  if (current) return { wait: current.promise }

  let settle!: (cached: Cached, retain: boolean) => void
  let once = false
  const promise = new Promise<Cached>((resolve) => {
    settle = (cached, retain) => {
      if (once) return
      once = true
      if (retain) {
        const slot = seen.get(key)
        if (slot) slot.expiresAt = now + WHATSAPP_DEDUPE_TTL_MS
        keepSettled(key)
      } else {
        drop(key)
      }
      resolve(cached)
    }
  })
  seen.set(key, { promise, expiresAt: IN_FLIGHT })
  return { settle }
}

/** Touch the store, then refuse. The body is not parsed for a user id. */
async function acknowledgeUnbound(
  deps: WebhookDeps,
  idempotencyKey: string,
  signal: AbortSignal,
  onAccepted: () => void
): Promise<Cached> {
  deps.store()
  const keys = deps.outboundKeys ?? (await openWhatsAppOutboundKeyStore())
  await sendWhatsAppOnce(
    deps.transport,
    { toUserId: "unbound", text: WHATSAPP_NOT_LINKED_TEXT },
    {
      signal,
      idempotencyKey,
      now: deps.now ?? Date.now(),
      idempotencyTtlMs: WHATSAPP_DEDUPE_TTL_MS,
      onAccepted,
      firmId: UNBOUND_OUTBOUND_FIRM,
      keys,
    }
  )
  return { status: 200, body: { ok: false } }
}

function bodyReadTimeout(): Response {
  return json(408, { error: "body_read_timeout" })
}

/**
 * Stop at the cap while reading, and stop if the body has not finished within
 * one deadline measured from the start of the read. A slow drip does not reset
 * that clock. The bytes are not signed until this returns a buffer.
 */
async function readCapped(request: Request): Promise<Buffer | Response> {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isFinite(size) || size < 0 || size > WHATSAPP_BODY_CAP_BYTES) {
      return json(413, { error: "payload_too_large" })
    }
  }
  const stream = request.body
  if (!stream) return Buffer.alloc(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => undefined)
  }, WHATSAPP_READ_DEADLINE_MS)
  try {
    for (;;) {
      let done = false
      let value: Uint8Array | undefined
      try {
        const next = await reader.read()
        done = next.done
        value = next.value
      } catch {
        return bodyReadTimeout()
      }
      if (timedOut) return bodyReadTimeout()
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (total + value.byteLength > WHATSAPP_BODY_CAP_BYTES) {
        await reader.cancel().catch(() => undefined)
        return json(413, { error: "payload_too_large" })
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    clearTimeout(timer)
    if (stream.locked) reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export async function handleWhatsAppWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (!isD2WhatsAppGrammarEnabled()) {
    return json(403, { error: "whatsapp_channel_disabled", flag: D2_WHATSAPP_GRAMMAR_FLAG })
  }

  const secret = deps.secret()
  if (!secretUsable(secret)) return json(401, { error: "webhook_not_configured" })

  const capped = await readCapped(request)
  if (capped instanceof Response) return capped
  if (!signaturesMatch(secret, capped, request.headers.get(SIGNATURE_HEADER))) {
    return json(401, { error: "bad_signature" })
  }

  if (request.headers.get("Idempotency-Key")) {
    try {
      deps.requireIdempotencyKey?.(request)
    } catch {
      return json(400, { error: "invalid_idempotency_key" })
    }
  }

  const now = deps.now ?? Date.now()
  const key = payloadKey(capped)
  const reserved = reserve(key, now)
  if ("wait" in reserved) {
    try {
      const cached = await withTimeout(reserved.wait, WHATSAPP_PROCESSING_TIMEOUT_MS)
      return json(cached.status, cached.body)
    } catch {
      return json(503, { ok: false })
    }
  }

  const controller = new AbortController()
  let accepted = false
  try {
    const cached = await withTimeout(
      acknowledgeUnbound(deps, key, controller.signal, () => {
        accepted = true
      }),
      WHATSAPP_PROCESSING_TIMEOUT_MS,
      () => controller.abort()
    )
    reserved.settle(cached, true)
    return json(cached.status, cached.body)
  } catch {
    controller.abort()
    if (accepted) {
      reserved.settle({ status: 200, body: { ok: false } }, true)
    } else {
      reserved.settle({ status: 503, body: { ok: false } }, false)
    }
    return json(503, { ok: false })
  }
}
